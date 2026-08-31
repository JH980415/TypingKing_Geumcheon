import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import lockfile from "proper-lockfile";
import {
  APP_VERSION,
  AUDIT_HEADER_LABELS,
  AUDIT_HEADERS,
  DEFAULT_CONFIG,
  DEFAULT_STAGE_TEXTS_BY_STAGE,
  RECORD_HEADER_LABELS,
  RECORD_HEADERS,
  STAGE_TEXT_HEADER_LABELS,
  STAGE_TEXT_HEADERS
} from "../constants/defaults";
import type {
  AppConfig,
  AuditRow,
  CsvBackupExportResult,
  CsvBackupStatus,
  DrawStageTextsInput,
  DrawStageTextsResult,
  GameStartReadiness,
  GeumcheonFairnessInput,
  LeaderboardSyncStatus,
  OneDriveCleanupResult,
  PcRole,
  RecordRow,
  SaveRecordInput,
  StageText
} from "../types";
import { formatBirthdate, formatMs, nowIso, timestampForFile } from "../utils/date";
import { buildPhoneFull, maskBirthdate, maskPhone, validatePhoneParts } from "../utils/masking";
import { compareLegacyAiRecords, compareRecords, isInterruptedRecord, rankCanonicalAiAttempts } from "../utils/ranking";
import { isCanonicalAiAttemptPubliclyRankable, isCanonicalAiAttemptV1 } from "../utils/geumcheonAiAttempt";
import { calculateFinalCpm, calculateTotalUserTimeMs, countConvertedTypingUnits, countTypeableChars } from "../utils/typing";
import { parseStageTextCatalog, validateStageTextCatalog } from "../events/stageTextCatalog";
import { drawStageTextFromBag, stageTextBagKey, type StageTextShuffleState } from "../utils/stageTextShuffle";

type RuntimePaths = {
  root: string;
  dataDir: string;
  configDir: string;
  assetsDir: string;
  exportsDir: string;
  backupsDir: string;
  recoveryDir: string;
  processedDir: string;
  localQueueDir: string;
  logsDir: string;
  recordsFile: string;
  stageTextsFile: string;
  auditFile: string;
  configFile: string;
};

export type RuntimeContext = {
  paths: RuntimePaths;
  config: AppConfig;
  notices: string[];
  assetBaseUrl: string;
};

const BOM = "\uFEFF";
const CSV_HEADER_LABELS: Record<string, string> = {
  ...RECORD_HEADER_LABELS,
  ...STAGE_TEXT_HEADER_LABELS,
  ...AUDIT_HEADER_LABELS,
  export_rank: "순위"
};
const EXPORT_RANK_HEADER = "export_rank";
const EXPORT_RECORD_HEADERS = [EXPORT_RANK_HEADER, ...RECORD_HEADERS] as const;
const CSV_HEADER_KEYS: Record<string, string> = {
  ...Object.fromEntries(
    [RECORD_HEADER_LABELS, STAGE_TEXT_HEADER_LABELS, AUDIT_HEADER_LABELS].flatMap((labels) =>
      Object.entries(labels).map(([key, label]) => [label, key])
    )
  ),
  순위: EXPORT_RANK_HEADER,
  참여자진행률: "participant_progress_percent",
  AI진행률: "ai_progress_percent"
};
const ONEDRIVE_ROOT_REQUIRED =
  "OneDrive 루트 폴더가 선택되지 않았습니다. 관리자모드에서 OneDrive 폴더를 선택해 주세요.";
const DAY_ROUND_REQUIRED = "일차와 회차를 입력해 주세요.";
const SETUP_REQUIRED =
  "기록 폴더 설정이 완료되지 않았습니다. 관리자모드에서 폴더 생성 및 검증을 실행해 주세요.";
const FOLDER_CREATE_FAILED =
  "기록 폴더를 생성할 수 없습니다. OneDrive 경로, 폴더 권한, 디스크 공간을 확인해 주세요.";
const LEADERBOARD_READ_FAILED =
  "기록 폴더를 읽을 수 없습니다. 현재 선택된 OneDrive 루트, 일차, 회차 설정을 확인해 주세요.";
const ONEDRIVE_READ_ONLY_RECORDS =
  "OneDrive JSON 원본 기록은 리더보드에서 직접 수정하거나 삭제하지 않습니다. 회차 종료 후 CSV 내보내기 파일로 관리해 주세요.";
const CSV_BACKUP_REQUIRED =
  "회차(일차)를 변경하기 전 현재 회차 CSV 백업이 필요합니다.\n관리자 모드의 [현재 회차 CSV 백업] 버튼을 눌러주세요.";

const START_SETUP_REQUIRED =
  "기록 저장 폴더 설정이 완료되지 않았습니다.\n관리자 모드에서 OneDrive 루트 폴더를 선택한 뒤 [폴더 생성 및 검증]을 먼저 실행해 주세요.";
const ONEDRIVE_ROOT_REQUIRED_KO =
  "OneDrive 루트 폴더가 선택되지 않았습니다. 관리자모드에서 OneDrive 폴더를 선택해 주세요.";
const DAY_ROUND_REQUIRED_KO = "일차와 회차를 입력해 주세요.";
const FOLDER_CREATE_FAILED_KO =
  "기록 폴더를 생성할 수 없습니다. OneDrive 경로, 폴더 권한, 디스크 공간을 확인해 주세요.";
const LEADERBOARD_READ_FAILED_KO =
  "기록 폴더를 읽을 수 없습니다. 현재 선택된 OneDrive 루트, 일차, 회차 설정을 확인해 주세요.";
const CURRENT_SESSION_BACKUP_BUTTON_LABEL = "현재 회차 CSV 백업";

const SETUP_REQUIRED_CLEAN =
  "기록 폴더 설정이 완료되지 않았습니다. 관리자모드에서 폴더 생성 및 검증을 실행해 주세요.";
const LEADERBOARD_READ_FAILED_CLEAN =
  "기록 폴더를 읽을 수 없습니다. 현재 선택된 OneDrive 루트, 일차, 회차 설정을 확인해 주세요.";
const CSV_BACKUP_REQUIRED_CLEAN =
  "회차(일차)를 변경하기 전 현재 회차 CSV 백업이 필요합니다.\n관리자 모드의 [현재 회차 CSV 백업] 버튼을 눌러주세요.";
const START_SETUP_REQUIRED_CLEAN =
  "기록 저장 폴더 설정이 완료되지 않았습니다.\n관리자 모드에서 OneDrive 루트 폴더를 선택한 뒤 [폴더 생성 및 검증]을 먼저 실행해 주세요.";
const ONEDRIVE_ROOT_REQUIRED_CLEAN =
  "OneDrive 루트 폴더가 선택되지 않았습니다. 관리자모드에서 OneDrive 폴더를 선택해 주세요.";
const DAY_ROUND_REQUIRED_CLEAN = "일차와 회차를 입력해 주세요.";
const FOLDER_CREATE_FAILED_CLEAN =
  "기록 폴더를 생성할 수 없습니다. OneDrive 경로, 폴더 권한, 디스크 공간을 확인해 주세요.";
const CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN = "현재 회차 CSV 백업";

type RecordMode = "normal" | "ai_challenge";

type ActiveSessionMarker = {
  marker_type: "active_session";
  record_base_folder_name: string;
  day_no: number;
  round_no: number;
  is_practice_session?: boolean;
  session_name: string;
  updated_at: string;
  updated_by_pc_id: string;
  updated_by_pc_role: PcRole;
};

const ACTIVE_SESSION_FILE_NAME = "active_session.json";
const ROOT_ACTIVE_SESSION_FILE_NAME = "typingking_active_session.json";
const SHARED_STAGE_TEXTS_FILE_NAME = "stage_texts.csv";
const ACTIVE_SESSION_EVENTS_DIR_NAME = "_active_sessions";
const ROOT_ACTIVE_SESSION_EVENTS_DIR_NAME = "_typingking_active_sessions";
const SHARED_STAGE_TEXTS_VERSIONS_DIR_NAME = "_stage_text_versions";
const SHARED_STATE_DIR_NAME = "_typingking_state";
const ACTIVE_SESSION_SNAPSHOTS_DIR_NAME = "active_sessions";
const STAGE_TEXT_SNAPSHOTS_DIR_NAME = "stage_texts";

export type StageTextPublishResult = {
  filePath: string;
  count: number;
  hash: string;
  updatedAt: string;
};

type OneDriveSettingsPatch = Partial<
  Pick<
    AppConfig,
    | "syncMode"
    | "pcRole"
    | "pcId"
    | "oneDriveRoot"
    | "recordBaseFolderName"
    | "dayNo"
    | "roundNo"
    | "isPracticeSession"
  >
>;

type AdminAction = {
  action_id: string;
  action_type: "hide" | "edit" | "reset_session";
  target_record_id?: string;
  created_at: string;
  admin_name?: string;
  admin_note?: string;
  day_no?: number;
  round_no?: number;
  game_mode?: "normal" | "ai_challenge";
  replacement_record?: unknown;
};

export type QueuedRecordStatus = {
  count: number;
};

export type QueuedRecordFlushResult = {
  attempted: number;
  sent: number;
  failed: number;
  targetPaths: string[];
  failures: Array<{ fileName: string; error: string }>;
};

type QueuedRecordTarget = {
  oneDriveRoot: string;
  recordBaseFolderName: string;
  dayNo: number;
  roundNo: number;
  practice: boolean;
};

type QueuedRecordEnvelope = {
  queue_version: 2;
  queued_at: string;
  target: QueuedRecordTarget;
  record: RecordRow;
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createRuntimePaths(root: string, assetRoot = root): RuntimePaths {
  const dataDir = path.join(root, "data");
  const configDir = path.join(root, "config");
  const assetsDir = path.join(assetRoot, "assets");
  const exportsDir = path.join(root, "exports");
  const backupsDir = path.join(dataDir, "backups");
  const recoveryDir = path.join(dataDir, "recovery");
  const processedDir = path.join(dataDir, "processed");
  // 연습모드는 큐/설정을 공식 실행기와 분리한다.
  // (공유 시: 공식 기록이 연습 폴더로 재전송되거나 연습 기록이 공식 회차로 올라가는 교차 오염 발생)
  const localQueueDir = path.join(dataDir, practiceSessionMode ? "local_queue_practice" : "local_queue");
  const logsDir = path.join(root, "logs");
  return {
    root,
    dataDir,
    configDir,
    assetsDir,
    exportsDir,
    backupsDir,
    recoveryDir,
    processedDir,
    localQueueDir,
    logsDir,
    recordsFile: path.join(dataDir, "records.csv"),
    stageTextsFile: path.join(dataDir, "stage_texts.csv"),
    auditFile: path.join(dataDir, "admin_audit.csv"),
    // 연습모드는 전용 설정 파일을 사용해 공식 config.json(일차/회차/setupComplete)을 절대 건드리지 않는다.
    configFile: path.join(configDir, practiceSessionMode ? "config.practice.json" : "config.json")
  };
}

export function ensureRuntime(root: string, assetRoot = root): RuntimeContext {
  const paths = createRuntimePaths(root, assetRoot);
  const notices: string[] = [];
  [
    paths.dataDir,
    paths.configDir,
    paths.assetsDir,
    paths.exportsDir,
    paths.backupsDir,
    paths.recoveryDir,
    paths.processedDir,
    paths.localQueueDir,
    paths.logsDir,
    path.join(paths.assetsDir, "logo"),
    path.join(paths.assetsDir, "background"),
    path.join(paths.assetsDir, "icons"),
    path.join(paths.assetsDir, "illustrations"),
    path.join(paths.assetsDir, "normal_typing"),
    path.join(paths.assetsDir, "ai_challenge"),
    path.join(paths.assetsDir, "fonts")
  ].forEach(ensureDir);

  const config = loadConfig(paths.configFile, notices);
  ensureRecordsFile(paths.recordsFile, notices);
  ensureStageTextsFile(paths.stageTextsFile, notices);
  ensureAuditFile(paths.auditFile);

  const ctx = {
    paths,
    config,
    notices,
    assetBaseUrl: pathToFileURL(paths.assetsDir).toString()
  };
  writeOperationalLog(ctx, { action: "app_start", result: "ok" });
  return ctx;
}

function loadConfig(configFile: string, notices: string[]): AppConfig {
  if (!fs.existsSync(configFile)) {
    // 연습모드 첫 실행: 같은 폴더의 공식 config.json에서 OneDrive 루트/기본 폴더명 등을 물려받아
    // 운영자가 루트를 다시 고르지 않아도 되게 한다. 단 폴더 검증은 연습 폴더 기준으로 다시 요구한다.
    if (practiceSessionMode) {
      const officialConfigFile = path.join(path.dirname(configFile), "config.json");
      if (fs.existsSync(officialConfigFile)) {
        try {
          const seeded = normalizeOneDriveConfig({
            ...cloneDefaultConfig(),
            ...(JSON.parse(fs.readFileSync(officialConfigFile, "utf8")) as Partial<AppConfig>),
            setupComplete: false,
            setupValidatedAt: ""
          });
          writeJsonAtomic(configFile, seeded);
          notices.push("연습모드 설정을 공식 설정에서 복사해 생성했습니다. 폴더 생성 및 검증을 실행해 주세요.");
          return seeded;
        } catch {
          // 공식 설정이 깨져 있으면 기본 설정으로 진행한다.
        }
      }
    }
    const config = cloneDefaultConfig();
    writeJsonAtomic(configFile, config);
    notices.push("설정 파일이 없어 기본 설정으로 생성합니다.");
    return config;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<AppConfig>;
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      theme: { ...DEFAULT_CONFIG.theme, ...(parsed.theme ?? {}) },
      aiChallenge: {
        ...DEFAULT_CONFIG.aiChallenge,
        ...(parsed.aiChallenge ?? {}),
        stageSpeedRanges: {
          ...DEFAULT_CONFIG.aiChallenge.stageSpeedRanges,
          ...(parsed.aiChallenge?.stageSpeedRanges ?? {})
        }
      }
    };
    if (!merged.adminPassword) {
      merged.adminPassword = DEFAULT_CONFIG.adminPassword;
      notices.push("관리자 비밀번호가 설정되어 있지 않아 기본 비밀번호를 적용합니다.");
    }
    if (
      typeof merged.leaderboardRefreshSeconds !== "number" ||
      merged.leaderboardRefreshSeconds < 1
    ) {
      merged.leaderboardRefreshSeconds = DEFAULT_CONFIG.leaderboardRefreshSeconds;
      notices.push("리더보드 새로고침 주기가 올바르지 않아 기본값 5초를 적용합니다.");
    }
    if (typeof merged.birthYearStart !== "number") merged.birthYearStart = 1900;
    merged.aiChallenge = sanitizeAiConfig(merged, notices);
    return normalizeOneDriveConfig(merged);
  } catch {
    notices.push("설정 파일 형식이 올바르지 않아 기본 설정을 적용합니다.");
    return normalizeOneDriveConfig({ ...DEFAULT_CONFIG });
  }
}

function sanitizeAiConfig(config: AppConfig, notices: string[]): AppConfig["aiChallenge"] {
  const ai = config.aiChallenge ?? DEFAULT_CONFIG.aiChallenge;
  const ranges = { ...DEFAULT_CONFIG.aiChallenge.stageSpeedRanges, ...ai.stageSpeedRanges };
  (["stage1", "stage2", "stage3"] as const).forEach((stage) => {
    const range = ranges[stage];
    if (
      !Number.isFinite(range.min) ||
      !Number.isFinite(range.max) ||
      range.min < 1 ||
      range.max < 1 ||
      range.min >= range.max
    ) {
      ranges[stage] = DEFAULT_CONFIG.aiChallenge.stageSpeedRanges[stage];
      notices.push("AI 타수 설정값이 올바르지 않습니다.");
    }
  });
  const countdownSeconds =
    Number.isFinite(ai.countdownSeconds) && ai.countdownSeconds >= 1
      ? Math.floor(ai.countdownSeconds)
      : DEFAULT_CONFIG.aiChallenge.countdownSeconds;
  if (countdownSeconds !== ai.countdownSeconds) {
    notices.push("카운트다운 설정값이 올바르지 않아 기본값을 적용합니다.");
  }
  const aiEnterDelayMs =
    Number.isFinite(ai.aiEnterDelayMs) && ai.aiEnterDelayMs >= 0
      ? Math.floor(ai.aiEnterDelayMs)
      : DEFAULT_CONFIG.aiChallenge.aiEnterDelayMs;
  const aiSpeedChangeIntervalMs =
    Number.isFinite(ai.aiSpeedChangeIntervalMs) && ai.aiSpeedChangeIntervalMs >= 100
      ? Math.floor(ai.aiSpeedChangeIntervalMs)
      : DEFAULT_CONFIG.aiChallenge.aiSpeedChangeIntervalMs;
  return {
    enabled: ai.enabled !== false,
    stageSpeedRanges: ranges,
    countdownSeconds,
    aiEnterDelayMs,
    aiSpeedChangeIntervalMs
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function normalizePcRole(value: unknown): PcRole {
  return value === "leaderboard" ? "leaderboard" : "player";
}

// 연습회차 전용 실행기(practice/practice-leaderboard) 모드.
// true면 세션 경로가 일차/회차 대신 고정 "연습회차" 폴더를 사용하고,
// 공식 회차 마커(active session) 쓰기/수신과 CSV 백업 강제 가드를 비활성화한다.
// 프로세스 시작 시 variant 기준으로 1회 설정되며 공유 config.json에는 기록되지 않는다.
let practiceSessionMode = false;

export function setPracticeSessionMode(enabled: boolean): void {
  practiceSessionMode = enabled;
}

export function isPracticeSessionMode(): boolean {
  return practiceSessionMode;
}

const PRACTICE_SESSION_DIR_NAME = "연습회차";
const PRACTICE_SESSION_NAME = "자유 연습회차";
const PRACTICE_STAGE_TEXT_READONLY =
  "연습모드에서는 문구를 변경하거나 공유할 수 없습니다. 공식 실행기의 관리자 모드에서 변경해 주세요.";

function withSessionPaths(config: AppConfig): AppConfig {
  const oneDriveRoot = String(config.oneDriveRoot ?? "").trim();
  const recordBaseFolderName =
    String(config.recordBaseFolderName ?? "").trim() || DEFAULT_CONFIG.recordBaseFolderName;
  const dayNo = positiveInteger(config.dayNo, DEFAULT_CONFIG.dayNo);
  const roundNo = positiveInteger(config.roundNo, DEFAULT_CONFIG.roundNo);
  const isPracticeSession = Boolean(config.isPracticeSession);
  const sessionName = practiceSessionMode ? PRACTICE_SESSION_NAME : `${dayNo}일차 ${roundNo}회차`;

  if (!oneDriveRoot) {
    return {
      ...config,
      oneDriveRoot,
      recordBaseFolderName,
      dayNo,
      roundNo,
      isPracticeSession,
      sessionName,
      sessionDataRoot: "",
      typingIncomingPath: "",
      aiIncomingPath: "",
      exportPath: "",
      logsPath: ""
    };
  }

  // 연습모드는 일차/회차와 무관한 전용 폴더를 사용해 공식 기록과 완전히 격리한다.
  const sessionDataRoot = practiceSessionMode
    ? path.join(oneDriveRoot, recordBaseFolderName, PRACTICE_SESSION_DIR_NAME)
    : path.join(oneDriveRoot, recordBaseFolderName, `${dayNo}일차`, `${roundNo}회차`);
  return {
    ...config,
    oneDriveRoot,
    recordBaseFolderName,
    dayNo,
    roundNo,
    isPracticeSession,
    sessionName,
    sessionDataRoot,
    typingIncomingPath: path.join(sessionDataRoot, "incoming", "typing"),
    aiIncomingPath: path.join(sessionDataRoot, "incoming", "ai"),
    exportPath: path.join(sessionDataRoot, "exports"),
    logsPath: path.join(sessionDataRoot, "logs")
  };
}

function normalizeOneDriveConfig(config: AppConfig): AppConfig {
  return withSessionPaths({
    ...config,
    syncMode: config.syncMode === "local" ? "local" : "onedrive_manual",
    pcRole: normalizePcRole(config.pcRole),
    pcId: String(config.pcId ?? "").trim() || DEFAULT_CONFIG.pcId,
    recordBaseFolderName:
      String(config.recordBaseFolderName ?? "").trim() || DEFAULT_CONFIG.recordBaseFolderName,
    dayNo: positiveInteger(config.dayNo, DEFAULT_CONFIG.dayNo),
    roundNo: positiveInteger(config.roundNo, DEFAULT_CONFIG.roundNo),
    isPracticeSession: Boolean(config.isPracticeSession),
    setupComplete: Boolean(config.setupComplete),
    setupValidatedAt: String(config.setupValidatedAt ?? ""),
    syncRetryMs:
      Number.isFinite(config.syncRetryMs) && config.syncRetryMs >= 500
        ? Math.floor(config.syncRetryMs)
        : DEFAULT_CONFIG.syncRetryMs,
    leaderboardRefreshMs:
      Number.isFinite(config.leaderboardRefreshMs) && config.leaderboardRefreshMs >= 1000
        ? Math.floor(config.leaderboardRefreshMs)
        : DEFAULT_CONFIG.leaderboardRefreshMs
  });
}

function persistConfig(ctx: RuntimeContext, config: AppConfig): AppConfig {
  const normalized = normalizeOneDriveConfig(config);
  writeJsonAtomic(ctx.paths.configFile, normalized);
  Object.assign(ctx.config, normalized);
  return ctx.config;
}

function shouldResetSetup(current: AppConfig, patch: OneDriveSettingsPatch): boolean {
  return (
    (patch.oneDriveRoot !== undefined && patch.oneDriveRoot !== current.oneDriveRoot) ||
    (patch.recordBaseFolderName !== undefined &&
      patch.recordBaseFolderName !== current.recordBaseFolderName) ||
    (patch.dayNo !== undefined && Number(patch.dayNo) !== Number(current.dayNo)) ||
    (patch.roundNo !== undefined && Number(patch.roundNo) !== Number(current.roundNo))
  );
}

function cloneDefaultConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    theme: { ...DEFAULT_CONFIG.theme },
    aiChallenge: {
      ...DEFAULT_CONFIG.aiChallenge,
      stageSpeedRanges: {
        stage1: { ...DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage1 },
        stage2: { ...DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage2 },
        stage3: { ...DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage3 }
      }
    }
  };
}

function shouldRequireCsvBackupBeforeSetupReset(
  current: AppConfig,
  patch: OneDriveSettingsPatch
): boolean {
  if (!current.setupComplete || !current.oneDriveRoot || !current.sessionDataRoot) return false;
  return (
    (patch.recordBaseFolderName !== undefined &&
      patch.recordBaseFolderName !== current.recordBaseFolderName) ||
    (patch.dayNo !== undefined && Number(patch.dayNo) !== Number(current.dayNo)) ||
    (patch.roundNo !== undefined && Number(patch.roundNo) !== Number(current.roundNo))
  );
}

function normalizeRecordMode(value?: string): RecordMode {
  return value === "ai_challenge" ? "ai_challenge" : "normal";
}

function recordBaseRoot(config: AppConfig): string {
  const root = String(config.oneDriveRoot ?? "").trim();
  if (!root) return "";
  const base = String(config.recordBaseFolderName ?? "").trim() || DEFAULT_CONFIG.recordBaseFolderName;
  return path.join(root, base);
}

function activeSessionMarkerPath(config: AppConfig): string {
  const base = recordBaseRoot(config);
  return base ? path.join(base, ACTIVE_SESSION_FILE_NAME) : "";
}

function rootActiveSessionMarkerPath(config: AppConfig): string {
  const root = String(config.oneDriveRoot ?? "").trim();
  return root ? path.join(root, ROOT_ACTIVE_SESSION_FILE_NAME) : "";
}

function activeSessionEventsDir(config: AppConfig): string {
  const base = recordBaseRoot(config);
  return base ? path.join(base, ACTIVE_SESSION_EVENTS_DIR_NAME) : "";
}

function rootActiveSessionEventsDir(config: AppConfig): string {
  const root = String(config.oneDriveRoot ?? "").trim();
  return root ? path.join(root, ROOT_ACTIVE_SESSION_EVENTS_DIR_NAME) : "";
}

function sharedStageTextsPath(config: AppConfig): string {
  const base = recordBaseRoot(config);
  return base ? path.join(base, SHARED_STAGE_TEXTS_FILE_NAME) : "";
}

function sharedStageTextsVersionsDir(config: AppConfig): string {
  const base = recordBaseRoot(config);
  return base ? path.join(base, SHARED_STAGE_TEXTS_VERSIONS_DIR_NAME) : "";
}

function activeSessionSnapshotsDir(config: AppConfig): string {
  const root = String(config.oneDriveRoot ?? "").trim();
  return root ? path.join(root, SHARED_STATE_DIR_NAME, ACTIVE_SESSION_SNAPSHOTS_DIR_NAME) : "";
}

function stageTextSnapshotsDir(config: AppConfig): string {
  const base = recordBaseRoot(config);
  return base ? path.join(base, SHARED_STATE_DIR_NAME, STAGE_TEXT_SNAPSHOTS_DIR_NAME) : "";
}

function deviceScopedFileName(prefix: string, config: AppConfig, extension: "json" | "csv"): string {
  const host = safeFilePart(os.hostname() || "WINDOWS-PC");
  const pcId = safeFilePart(config.pcId || DEFAULT_CONFIG.pcId);
  const role = safeFilePart(config.pcRole || "pc");
  return `${prefix}_${host}_${pcId}_${role}.${extension}`;
}

function stackedFileName(prefix: string, pcId: string, extension: "json" | "csv"): string {
  const date = new Date();
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const identity = safeFilePart(pcId || DEFAULT_CONFIG.pcId);
  const nonce = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${timestampForFile(date)}_${milliseconds}_${identity}_${process.pid}_${nonce}.${extension}`;
}

function uniqueOperationStamp(ctx: RuntimeContext): string {
  return stackedFileName("stamp", ctx.config.pcId || DEFAULT_CONFIG.pcId, "json")
    .replace(/^stamp_/, "")
    .replace(/\.json$/, "");
}

function directoryReady(dir: string): boolean {
  try {
    return Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function normalizeActiveSessionMarker(source: Partial<ActiveSessionMarker>, config: AppConfig): ActiveSessionMarker | null {
  const dayNo = Number(source.day_no);
  const roundNo = Number(source.round_no);
  if (!Number.isFinite(dayNo) || !Number.isFinite(roundNo) || dayNo <= 0 || roundNo <= 0) return null;
  return {
    marker_type: "active_session",
    record_base_folder_name: String(source.record_base_folder_name ?? config.recordBaseFolderName ?? ""),
    day_no: Math.floor(dayNo),
    round_no: Math.floor(roundNo),
    is_practice_session: Boolean(source.is_practice_session),
    session_name: String(source.session_name ?? `${Math.floor(dayNo)}일차 ${Math.floor(roundNo)}회차`),
    updated_at: String(source.updated_at ?? ""),
    updated_by_pc_id: String(source.updated_by_pc_id ?? ""),
    updated_by_pc_role: normalizePcRole(source.updated_by_pc_role)
  };
}

function readActiveSessionMarker(config: AppConfig): ActiveSessionMarker | null {
  const snapshotDir = activeSessionSnapshotsDir(config);
  if (snapshotDir && fs.existsSync(snapshotDir)) {
    const snapshots: Array<{ marker: ActiveSessionMarker; sortKey: string }> = [];
    for (const fileName of fs.readdirSync(snapshotDir).filter((name) => name.toLowerCase().endsWith(".json"))) {
      try {
        const marker = normalizeActiveSessionMarker(
          JSON.parse(fs.readFileSync(path.join(snapshotDir, fileName), "utf8")) as Partial<ActiveSessionMarker>,
          config
        );
        if (marker) snapshots.push({ marker, sortKey: `${marker.updated_at || ""}_${fileName}` });
      } catch {
        continue;
      }
    }
    if (snapshots.length > 0) {
      snapshots.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
      return snapshots[0].marker;
    }
  }

  // 새 장치별 상태 파일이 만들어지기 전까지만 기존 누적형 파일을 읽는다.
  const candidates: Array<{ marker: ActiveSessionMarker; sortKey: string }> = [];
  const eventDirs = [rootActiveSessionEventsDir(config), activeSessionEventsDir(config)].filter(Boolean);
  for (const dir of eventDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const fileName of fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"))) {
      const markerPath = path.join(dir, fileName);
      try {
        const marker = normalizeActiveSessionMarker(
          JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<ActiveSessionMarker>,
          config
        );
        if (marker) candidates.push({ marker, sortKey: `${marker.updated_at || ""}_${fileName}` });
      } catch {
        continue;
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return candidates[0].marker;
  }

  const legacyPaths = [rootActiveSessionMarkerPath(config), activeSessionMarkerPath(config)].filter(Boolean);
  for (const markerPath of legacyPaths) {
    if (!fs.existsSync(markerPath)) continue;
    try {
      const marker = normalizeActiveSessionMarker(
        JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<ActiveSessionMarker>,
        config
      );
      if (marker) return marker;
    } catch {
      continue;
    }
  }
  return null;
}

function writeActiveSessionMarker(ctx: RuntimeContext, config: AppConfig): string {
  // 연습모드 실행기는 공식 운영 회차 마커를 절대 쓰지 않는다(공식 PC들의 회차를 바꾸면 안 됨).
  if (practiceSessionMode) return "";
  const snapshotDir = activeSessionSnapshotsDir(config);
  if (!snapshotDir) return "";
  const marker: ActiveSessionMarker = {
    marker_type: "active_session",
    record_base_folder_name: config.recordBaseFolderName,
    day_no: Number(config.dayNo),
    round_no: Number(config.roundNo),
    is_practice_session: Boolean(config.isPracticeSession),
    session_name: config.sessionName || `${config.dayNo}일차 ${config.roundNo}회차`,
    updated_at: nowIso(),
    updated_by_pc_id: config.pcId,
    updated_by_pc_role: normalizePcRole(config.pcRole)
  };
  const markerPath = path.join(snapshotDir, deviceScopedFileName("active_session", config, "json"));
  if (fs.existsSync(markerPath)) {
    try {
      const current = normalizeActiveSessionMarker(
        JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<ActiveSessionMarker>,
        config
      );
      const latest = readActiveSessionMarker(config);
      if (
        current &&
        latest &&
        current.record_base_folder_name === marker.record_base_folder_name &&
        current.day_no === marker.day_no &&
        current.round_no === marker.round_no &&
        Boolean(current.is_practice_session) === Boolean(marker.is_practice_session) &&
        current.session_name === marker.session_name &&
        latest.record_base_folder_name === marker.record_base_folder_name &&
        latest.day_no === marker.day_no &&
        latest.round_no === marker.round_no &&
        Boolean(latest.is_practice_session) === Boolean(marker.is_practice_session)
      ) {
        return markerPath;
      }
    } catch {
      // 손상된 자기 상태 파일은 아래 원자적 저장으로 교체한다.
    }
  }
  writeJsonAtomic(markerPath, marker);
  writeOperationalLog(ctx, {
    action: "active_session_marker_written",
    targetPath: markerPath,
    result: "success",
    details: { dayNo: marker.day_no, roundNo: marker.round_no, mode: "device_snapshot" }
  });
  return markerPath;
}

function syncConfigFromActiveSession(ctx: RuntimeContext): AppConfig {
  // 연습모드는 고정 폴더를 사용하므로 공식 회차 마커를 수신/반영하지 않는다.
  if (practiceSessionMode) return ctx.config;
  const marker = readActiveSessionMarker(ctx.config);
  if (!marker) return ctx.config;
  const next = normalizeOneDriveConfig({
    ...ctx.config,
    recordBaseFolderName: marker.record_base_folder_name || ctx.config.recordBaseFolderName,
    dayNo: marker.day_no,
    roundNo: marker.round_no,
    isPracticeSession: Boolean(marker.is_practice_session)
  });
  const foldersReady =
    directoryReady(next.sessionDataRoot) &&
    directoryReady(next.typingIncomingPath) &&
    directoryReady(next.aiIncomingPath) &&
    directoryReady(next.exportPath);
  const hasBeenValidatedBefore = Boolean(ctx.config.setupComplete || ctx.config.setupValidatedAt);
  const nextSetupComplete = hasBeenValidatedBefore && foldersReady;
  const changed =
    next.recordBaseFolderName !== ctx.config.recordBaseFolderName ||
    Number(next.dayNo) !== Number(ctx.config.dayNo) ||
    Number(next.roundNo) !== Number(ctx.config.roundNo) ||
    Boolean(next.isPracticeSession) !== Boolean(ctx.config.isPracticeSession) ||
    Boolean(ctx.config.setupComplete) !== nextSetupComplete;
  if (!changed) return ctx.config;
  const saved = persistConfig(ctx, {
    ...next,
    setupComplete: nextSetupComplete,
    setupValidatedAt: nextSetupComplete ? marker.updated_at || ctx.config.setupValidatedAt || nowIso() : ""
  });
  writeOperationalLog(ctx, {
    action: "active_session_synced",
    targetPath: saved.sessionDataRoot,
    result: "ok",
    details: {
      dayNo: saved.dayNo,
      roundNo: saved.roundNo,
      isPracticeSession: saved.isPracticeSession,
      recordBaseFolderName: saved.recordBaseFolderName,
      foldersReady,
      hasBeenValidatedBefore
    }
  });
  return saved;
}

function isActiveSessionMismatch(marker: ActiveSessionMarker | null, config: AppConfig): boolean {
  if (!marker) return false;
  return Number(marker.day_no) !== Number(config.dayNo) || Number(marker.round_no) !== Number(config.roundNo);
}

function activeSessionMismatchMessage(marker: ActiveSessionMarker): string {
  return `${marker.day_no}일차 ${marker.round_no}회차로 변경해 주세요!`;
}

function backupRequiredMessage(modes: RecordMode[]): string {
  const unique = [...new Set(modes)];
  if (unique.length === 1 && unique[0] === "normal") {
    return "회차(일차)를 변경하기 전 일반 타자왕 CSV 백업이 필요합니다.\n일반 리더보드 관리자 모드의 [현재 회차 CSV 백업] 버튼을 눌러주세요.";
  }
  if (unique.length === 1 && unique[0] === "ai_challenge") {
    return "회차(일차)를 변경하기 전 AI 타자왕 CSV 백업이 필요합니다.\nAI 리더보드 관리자 모드의 [현재 회차 CSV 백업] 버튼을 눌러주세요.";
  }
  if (unique.length > 1) {
    return "회차(일차)를 변경하기 전 일반 타자왕과 AI 타자왕 CSV 백업이 필요합니다.\n각 리더보드 관리자 모드의 [현재 회차 CSV 백업] 버튼을 눌러주세요.";
  }
  return CSV_BACKUP_REQUIRED_CLEAN;
}

function backupRequiredMessageKo(modes: RecordMode[]): string {
  const unique = [...new Set(modes)];
  if (unique.length === 1 && unique[0] === "normal") {
    return `회차(일차)를 변경하기 전 일반 타자왕 CSV 백업이 필요합니다.\n일반 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  if (unique.length === 1 && unique[0] === "ai_challenge") {
    return `회차(일차)를 변경하기 전 AI 타자왕 CSV 백업이 필요합니다.\nAI 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  if (unique.length > 1) {
    return `회차(일차)를 변경하기 전 일반 타자왕과 AI 타자왕 CSV 백업이 필요합니다.\n각 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  return `회차(일차)를 변경하기 전 현재 회차 CSV 백업이 필요합니다.\n관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
}

function backupMarkerHash(recordIds: string[]): string {
  return crypto.createHash("sha256").update([...recordIds].sort().join("\n")).digest("hex");
}

function backupRequiredMessageClean(modes: RecordMode[]): string {
  const unique = [...new Set(modes)];
  if (unique.length === 1 && unique[0] === "normal") {
    return `회차(일차)를 변경하기 전 일반 타자왕 CSV 백업이 필요합니다.\n일반 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  if (unique.length === 1 && unique[0] === "ai_challenge") {
    return `회차(일차)를 변경하기 전 AI 타자왕 CSV 백업이 필요합니다.\nAI 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  if (unique.length > 1) {
    return `회차(일차)를 변경하기 전 일반 타자왕과 AI 타자왕 CSV 백업이 필요합니다.\n각 리더보드 관리자 모드의 [${CURRENT_SESSION_BACKUP_BUTTON_LABEL_CLEAN}] 버튼을 눌러주세요.`;
  }
  return CSV_BACKUP_REQUIRED_CLEAN;
}

function backupStaleReasonClean(recordCount: number, isFresh: boolean, hasMarker: boolean): string {
  if (recordCount === 0 || isFresh) return "";
  return hasMarker
    ? "CSV 백업 이후 새 기록이 추가되어 다시 백업이 필요합니다."
    : "현재 회차 CSV 백업이 필요합니다.";
}

function sessionBackupEmptyMessage(): string {
  return "현재 회차에 백업할 기록이 없습니다. 기록 0건 회차는 백업 없이 회차 변경이 가능합니다.";
}

function sessionBackupFileName(ctx: RuntimeContext, mode: RecordMode): string {
  const modeLabel = mode === "ai_challenge" ? "AI타자왕" : "일잘러타자왕";
  const sessionLabel = practiceSessionMode
    ? PRACTICE_SESSION_DIR_NAME
    : `${ctx.config.dayNo}일차_${ctx.config.roundNo}회차`;
  return `${modeLabel}_${sessionLabel}_리더보드_${uniqueOperationStamp(ctx)}.csv`;
}

function sessionBackupDoneMessage(count: number, fileName: string): string {
  return `현재 회차 CSV 백업이 완료되었습니다.\n백업 기록 수: ${count}건\n파일명: ${fileName}`;
}

function backupMarkerDir(ctx: RuntimeContext): string {
  return ctx.config.exportPath || path.join(ctx.config.sessionDataRoot, "exports");
}

function currentBackupTargetRecords(ctx: RuntimeContext, mode: RecordMode): RecordRow[] {
  return readRecords(ctx)
    .filter((record) => normalizeRecordMode(record.game_mode) === mode)
    .filter((record) => record.is_test !== "true" && record.is_debug !== "true");
}

function withExportRanks(
  rows: RecordRow[],
  mode: RecordMode
): Array<RecordRow & { export_rank: string }> {
  if (mode !== "ai_challenge") {
    return [...rows]
      .sort(compareRecords)
      .map((row, index) => ({ export_rank: String(index + 1), ...row }));
  }

  const canonicalRows = rows.flatMap((row) => {
    const attempt = row.canonicalAttempt;
    if (!attempt || !isCanonicalAiAttemptPubliclyRankable(attempt, {
      recordId: row.record_id
    })) {
      return [];
    }
    return [{ row, attempt }];
  });
  const rowByAttempt = new Map(
    canonicalRows.map(({ row, attempt }) => [attempt, row])
  );
  const rankedAttempts = rankCanonicalAiAttempts(
    canonicalRows.map(({ attempt }) => attempt)
  );
  const publiclyRankedAttempts = new Set(
    rankedAttempts.map(({ record: attempt }) => attempt)
  );
  const rankedCanonical = rankedAttempts.map(({ rank, record: attempt }) => ({
    export_rank: String(rank),
    ...rowByAttempt.get(attempt)!
  }));
  const legacyRows = rows
    .filter((row) => row.canonicalAttempt == null)
    .sort(compareLegacyAiRecords)
    .map((row, index) => ({
      export_rank: String(rankedCanonical.length + index + 1),
      ...row
    }));
  const quarantinedRows = rows
    .filter((row) => row.canonicalAttempt != null &&
      !publiclyRankedAttempts.has(row.canonicalAttempt))
    .map((row) => ({ export_rank: "", ...row }));
  return [...rankedCanonical, ...legacyRows, ...quarantinedRows];
}

function readBackupMarkers(ctx: RuntimeContext, mode: RecordMode): Array<{
  day_no: number;
  round_no: number;
  game_mode: RecordMode;
  exported_record_count: number;
  record_ids: string[];
  record_id_hash: string;
  exported_at: string;
  csv_file_name: string;
  file_mtime_ms: number;
}> {
  const dir = backupMarkerDir(ctx);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().startsWith("csv_backup_") && name.toLowerCase().endsWith(".json"))
    .flatMap((name) => {
      try {
        const source = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
        const markerMode =
          source.game_mode == null
            ? name.toLowerCase().includes("ai_challenge")
              ? "ai_challenge"
              : "normal"
            : normalizeRecordMode(String(source.game_mode ?? ""));
        if (markerMode !== mode) return [];
        const markerPath = path.join(dir, name);
        const stat = fs.statSync(markerPath);
        return [
          {
            day_no: Number(source.day_no),
            round_no: Number(source.round_no),
            game_mode: markerMode,
            exported_record_count: Number(source.exported_record_count) || 0,
            record_ids: Array.isArray(source.record_ids) ? source.record_ids.map(String) : [],
            record_id_hash: String(source.record_id_hash ?? ""),
            exported_at: String(source.exported_at ?? ""),
            csv_file_name: String(source.csv_file_name ?? ""),
            file_mtime_ms: stat.mtimeMs
          }
        ];
      } catch {
        return [];
      }
    });
}

function hasFreshBackupMarker(ctx: RuntimeContext, mode: RecordMode, records: RecordRow[]): boolean {
  if (records.length === 0) return true;
  const currentIds = records.map((record) => record.record_id).filter(Boolean).sort();
  const currentHash = backupMarkerHash(currentIds);
  return readBackupMarkers(ctx, mode).some((marker) => {
    if (Number(marker.day_no) !== Number(ctx.config.dayNo)) return false;
    if (Number(marker.round_no) !== Number(ctx.config.roundNo)) return false;
    if (marker.game_mode !== mode) return false;
    if (marker.exported_record_count !== currentIds.length) return false;
    if (marker.record_id_hash && marker.record_id_hash === currentHash) return true;
    return backupMarkerHash(marker.record_ids) === currentHash;
  });
}

function missingBackupModes(ctx: RuntimeContext, modes: RecordMode[] = ["normal", "ai_challenge"]): RecordMode[] {
  if (!usesOneDriveJson(ctx) || !ctx.config.setupComplete || !ctx.config.sessionDataRoot) return [];
  const missing: RecordMode[] = [];
  for (const mode of modes) {
    const records = currentBackupTargetRecords(ctx, mode);
    if (records.length > 0 && !hasFreshBackupMarker(ctx, mode, records)) missing.push(mode);
  }
  return missing;
}

function assertCsvBackupReady(ctx: RuntimeContext, modes?: RecordMode[]): void {
  // 연습회차 기록은 시상/집계 대상이 아니므로 CSV 백업을 강제하지 않는다.
  if (practiceSessionMode) return;
  const missing = missingBackupModes(ctx, modes);
  if (missing.length > 0) {
    writeOperationalLog(ctx, {
      level: "warn",
      action: "session_change_blocked",
      result: "csv_backup_required",
      details: { missing }
    });
    throw new Error(backupRequiredMessageClean(missing));
  }
}

function writeCsvBackupMarker(ctx: RuntimeContext, mode: RecordMode, csvFileName: string, exportedRows: RecordRow[]): string {
  if (!usesOneDriveJson(ctx)) return "";
  const targetRecords = currentBackupTargetRecords(ctx, mode);
  if (targetRecords.length === 0) return "";
  const exportedIds = new Set(exportedRows.map((row) => row.record_id));
  if (!targetRecords.every((record) => exportedIds.has(record.record_id))) return "";
  const recordIds = targetRecords.map((record) => record.record_id).sort();
  const dir = backupMarkerDir(ctx);
  ensureDir(dir);
  const markerPath = path.join(
    dir,
    deviceScopedFileName(
      `csv_backup_${safeFilePart(mode)}_${ctx.config.dayNo}day_${ctx.config.roundNo}round`,
      ctx.config,
      "json"
    )
  );
  writeJsonAtomic(
    markerPath,
    {
      marker_type: "csv_backup",
      day_no: ctx.config.dayNo,
      round_no: ctx.config.roundNo,
      game_mode: mode,
      exported_at: nowIso(),
      csv_file_name: csvFileName,
      exported_record_count: recordIds.length,
      record_id_hash: backupMarkerHash(recordIds)
    }
  );
  writeOperationalLog(ctx, {
    action: "csv_backup_marker_created",
    targetPath: markerPath,
    result: "success",
    details: { mode, count: recordIds.length, csvFileName }
  });
  return path.basename(markerPath);
}

function newestBackupMarker(ctx: RuntimeContext, mode: RecordMode) {
  return readBackupMarkers(ctx, mode)
    .filter((marker) => Number(marker.day_no) === Number(ctx.config.dayNo))
    .filter((marker) => Number(marker.round_no) === Number(ctx.config.roundNo))
    .sort((a, b) => {
      const byTime = (Date.parse(a.exported_at) || a.file_mtime_ms) - (Date.parse(b.exported_at) || b.file_mtime_ms);
      if (byTime !== 0) return byTime;
      return String(a.record_id_hash).localeCompare(String(b.record_id_hash));
    })
    .at(-1);
}

export function getCsvBackupStatus(ctx: RuntimeContext): CsvBackupStatus {
  const makeModeStatus = (mode: RecordMode) => {
    const records = currentBackupTargetRecords(ctx, mode);
    const recordIds = records.map((record) => record.record_id).filter(Boolean).sort();
    const recordIdHash = backupMarkerHash(recordIds);
    const marker = newestBackupMarker(ctx, mode);
    const isFresh = records.length === 0 || hasFreshBackupMarker(ctx, mode, records);
    return {
      mode,
      required: records.length > 0,
      complete: isFresh,
      recordCount: records.length,
      backedUpRecordCount: marker?.exported_record_count ?? 0,
      latestBackupAt: marker?.exported_at ?? "",
      latestCsvFileName: marker?.csv_file_name ?? "",
      recordIdHash,
      markerHash: marker?.record_id_hash ?? "",
      staleReason:
        records.length === 0
          ? ""
          : isFresh
            ? ""
            : marker
              ? "CSV 백업 이후 새 기록이 추가되어 다시 백업이 필요합니다."
              : "현재 회차 CSV 백업이 필요합니다."
    };
  };
  const normal = makeModeStatus("normal");
  const ai = makeModeStatus("ai_challenge");
  normal.staleReason = backupStaleReasonClean(normal.recordCount, normal.complete, Boolean(normal.markerHash));
  ai.staleReason = backupStaleReasonClean(ai.recordCount, ai.complete, Boolean(ai.markerHash));
  return {
    sessionName: ctx.config.sessionName,
    dayNo: ctx.config.dayNo,
    roundNo: ctx.config.roundNo,
    normal,
    ai,
    missingModes: [normal, ai].filter((item) => item.required && !item.complete).map((item) => item.mode)
  };
}

export function exportCurrentSessionBackup(
  ctx: RuntimeContext,
  gameMode: "normal" | "ai_challenge"
): CsvBackupExportResult {
  const mode = normalizeRecordMode(gameMode);
  const rows = currentBackupTargetRecords(ctx, mode);
  if (rows.length === 0) {
    return {
      fileName: "",
      markerFileName: "",
      exportedRecordCount: 0,
      recordIds: [],
      recordIdHash: backupMarkerHash([]),
      message: "현재 회차에 백업할 기록이 없습니다. 기록 0건 회차는 백업 없이 회차 변경이 가능합니다."
    };
  }
  const exportDir = ctx.config.exportPath || ctx.paths.exportsDir;
  ensureDir(exportDir);
  const modeLabel = mode === "ai_challenge" ? "AI타자왕" : "일잘러타자왕";
  const fileName = `${modeLabel}_${ctx.config.dayNo}일차_${ctx.config.roundNo}회차_리더보드_${uniqueOperationStamp(ctx)}.csv`;
  const filePath = path.join(exportDir, fileName);
  const exportRows = withExportRanks(rows, mode);
  writeCsvAtomic(filePath, exportRows, EXPORT_RECORD_HEADERS);
  const markerFileName = writeCsvBackupMarker(ctx, mode, fileName, exportRows);
  const recordIds = exportRows.map((row) => row.record_id).filter(Boolean).sort();
  writeOperationalLog(ctx, {
    action: "csv_backup_export",
    targetPath: filePath,
    result: "success",
    details: { mode, count: rows.length, markerFileName }
  });
  return {
    fileName,
    markerFileName,
    exportedRecordCount: rows.length,
    recordIds,
    recordIdHash: backupMarkerHash(recordIds),
    message: `현재 회차 CSV 백업이 완료되었습니다.\n백업 기록 수: ${rows.length}건\n파일명: ${fileName}`
  };
}

export function exportCurrentSessionBackupClean(
  ctx: RuntimeContext,
  gameMode: "normal" | "ai_challenge"
): CsvBackupExportResult {
  const mode = normalizeRecordMode(gameMode);
  const rows = currentBackupTargetRecords(ctx, mode);
  if (rows.length === 0) {
    return {
      fileName: "",
      markerFileName: "",
      exportedRecordCount: 0,
      recordIds: [],
      recordIdHash: backupMarkerHash([]),
      message: sessionBackupEmptyMessage()
    };
  }
  const exportDir = ctx.config.exportPath || ctx.paths.exportsDir;
  ensureDir(exportDir);
  const fileName = sessionBackupFileName(ctx, mode);
  const filePath = path.join(exportDir, fileName);
  const exportRows = withExportRanks(rows, mode);
  writeCsvAtomic(filePath, exportRows, EXPORT_RECORD_HEADERS);
  const markerFileName = writeCsvBackupMarker(ctx, mode, fileName, exportRows);
  const recordIds = exportRows.map((row) => row.record_id).filter(Boolean).sort();
  writeOperationalLog(ctx, {
    action: "csv_backup_export",
    targetPath: filePath,
    result: "success",
    details: { mode, count: rows.length, markerFileName }
  });
  return {
    fileName,
    markerFileName,
    exportedRecordCount: rows.length,
    recordIds,
    recordIdHash: backupMarkerHash(recordIds),
    message: sessionBackupDoneMessage(rows.length, fileName)
  };
}

export function getOneDriveSettings(ctx: RuntimeContext, role?: PcRole): AppConfig {
  syncConfigFromActiveSession(ctx);
  const adjusted = normalizeOneDriveConfig({
    ...ctx.config,
    pcRole: role ?? ctx.config.pcRole
  });
  Object.assign(ctx.config, adjusted);
  return ctx.config;
}

export function updateOneDriveSettings(
  ctx: RuntimeContext,
  patch: OneDriveSettingsPatch,
  role?: PcRole
): AppConfig {
  const resetsSetup = shouldResetSetup(ctx.config, patch);
  if (resetsSetup && shouldRequireCsvBackupBeforeSetupReset(ctx.config, patch)) {
    assertCsvBackupReady(ctx);
  }
  const setupComplete = resetsSetup ? false : ctx.config.setupComplete;
  const saved = persistConfig(ctx, {
    ...ctx.config,
    ...patch,
    pcRole: patch.pcRole ?? role ?? ctx.config.pcRole,
    setupComplete,
    setupValidatedAt: setupComplete ? ctx.config.setupValidatedAt : ""
  });
  if (
    saved.syncMode === "onedrive_manual" &&
    saved.oneDriveRoot &&
    (patch.recordBaseFolderName !== undefined ||
      patch.dayNo !== undefined ||
      patch.roundNo !== undefined ||
      patch.isPracticeSession !== undefined)
  ) {
    writeActiveSessionMarker(ctx, saved);
  }
  return saved;
}

export function validateOneDriveSetup(ctx: RuntimeContext, role?: PcRole): AppConfig {
  const next = normalizeOneDriveConfig({
    ...ctx.config,
    pcRole: role ?? ctx.config.pcRole,
    syncMode: "onedrive_manual"
  });
  if (!next.oneDriveRoot) throw new Error(ONEDRIVE_ROOT_REQUIRED_CLEAN);
  if (!next.dayNo || !next.roundNo) throw new Error(DAY_ROUND_REQUIRED_CLEAN);

  try {
    [
      ctx.paths.localQueueDir,
      ctx.paths.backupsDir,
      ctx.paths.recoveryDir,
      ctx.paths.processedDir,
      ctx.paths.logsDir,
      next.sessionDataRoot,
      next.typingIncomingPath,
      next.aiIncomingPath,
      next.exportPath,
      next.logsPath,
      adminActionsDir(next)
    ].forEach(ensureDir);
    const probePath = path.join(next.logsPath, `.write_test_${process.pid}.tmp`);
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);
  } catch (error) {
    writeOperationalLog(ctx, {
      level: "error",
      action: "validate_onedrive_setup",
      result: "failed",
      targetPath: next.sessionDataRoot,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`${FOLDER_CREATE_FAILED_CLEAN}${error instanceof Error ? ` (${error.message})` : ""}`);
  }

  const saved = persistConfig(ctx, {
    ...next,
    setupComplete: true,
    setupValidatedAt: nowIso()
  });
  const activeSessionPath = writeActiveSessionMarker(ctx, saved);
  writeOperationalLog(ctx, {
    action: "validate_onedrive_setup",
    result: "ok",
    targetPath: saved.sessionDataRoot,
    details: { activeSessionPath }
  });
  return saved;
}

function readStageTextShuffleState(filePath: string): StageTextShuffleState {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { schemaVersion: 2, bags: {} };
    const state = value as Partial<StageTextShuffleState>;
    if (state.schemaVersion !== 2 || !state.bags || typeof state.bags !== "object" || Array.isArray(state.bags)) {
      return { schemaVersion: 2, bags: {} };
    }
    const bags: StageTextShuffleState["bags"] = {};
    for (const [key, bag] of Object.entries(state.bags)) {
      if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
      const candidate = bag as { remainingIds?: unknown; lastSelectedId?: unknown };
      if (!Array.isArray(candidate.remainingIds)) continue;
      bags[key] = {
        remainingIds: candidate.remainingIds.filter((id): id is string => typeof id === "string"),
        ...(typeof candidate.lastSelectedId === "string" ? { lastSelectedId: candidate.lastSelectedId } : {})
      };
    }
    return { schemaVersion: 2, bags };
  } catch {
    return { schemaVersion: 2, bags: {} };
  }
}

export function drawGeumcheonStageTexts(
  ctx: RuntimeContext,
  input: DrawStageTextsInput & { eventId: string; catalogVersion: string; catalogPath: string; role: "player" | "leaderboard" }
): DrawStageTextsResult {
  if (input.role !== "player") throw new Error("Stage catalog draws require player role");
  const rows = parseStageTextCatalog(fs.readFileSync(input.catalogPath, "utf8"));
  validateStageTextCatalog(rows, {
    expectedVersion: input.catalogVersion,
    expectedMode: "ai_challenge",
    expectedRowsPerStage: 20
  });
  const statePath = path.join(ctx.paths.root, "state", "stage-text-shuffle.json");
  let state = readStageTextShuffleState(statePath);
  const selections = ([1, 2, 3] as const).map((stageNumber) => {
    const result = drawStageTextFromBag(
      rows.filter((row) => row.stage_number === String(stageNumber)),
      stageTextBagKey({
        eventId: input.eventId,
        catalogVersion: input.catalogVersion,
        sessionKind: input.sessionKind,
        gameMode: input.gameMode,
        stageNumber
      }),
      state
    );
    state = result.nextState;
    return {
      id: result.selected.id,
      catalogVersion: input.catalogVersion,
      stageNumber,
      text: result.selected.text
    };
  });
  writeJsonAtomic(statePath, state);
  return {
    catalogVersion: input.catalogVersion,
    selections: [selections[0], selections[1], selections[2]]
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function operationalLogFile(prefix = "app", identity?: { pcId?: string; pcRole?: string }): string {
  const suffix = identity
    ? `_${safeFilePart(identity.pcId || DEFAULT_CONFIG.pcId)}_${safeFilePart(identity.pcRole || "pc")}_${process.pid}`
    : "";
  return `${prefix}_${timestampForFile().slice(0, 8)}${suffix}.log`;
}

function writeOperationalLog(
  ctx: RuntimeContext,
  entry: {
    level?: "info" | "warn" | "error";
    action: string;
    sourcePath?: string;
    targetPath?: string;
    recordId?: string;
    result?: string;
    errorMessage?: string;
    details?: Record<string, unknown>;
  }
): void {
  const payload = {
    timestamp: nowIso(),
    level: entry.level ?? "info",
    pcId: ctx.config.pcId,
    pcRole: ctx.config.pcRole,
    appVariant: ctx.config.pcRole,
    dayNo: ctx.config.dayNo,
    roundNo: ctx.config.roundNo,
    action: entry.action,
    source_path: entry.sourcePath ?? "",
    target_path: entry.targetPath ?? "",
    record_id: entry.recordId ?? "",
    result: entry.result ?? "",
    error_message: entry.errorMessage ?? "",
    details: entry.details ?? {}
  };
  try {
    appendJsonl(path.join(ctx.paths.logsDir, operationalLogFile()), payload);
  } catch {
    // 로깅 실패가 실제 기록 저장을 막으면 안 됩니다.
  }
  // 운영 로그는 각 PC의 data/logs에만 남긴다. 자동 새로고침을 수행하는 여러 리더보드가
  // OneDrive 공유 로그 파일을 동시에 쓰면 충돌 복사본과 불필요한 동기화 파일이 늘어난다.
}

function scanDirectoryForOneDrive(dir: string): { path: string; exists: boolean; fileCount: number } {
  try {
    if (!dir || !fs.existsSync(dir)) return { path: dir, exists: false, fileCount: 0 };
    const names = fs.readdirSync(dir);
    for (const name of names.slice(0, 20)) {
      try {
        fs.statSync(path.join(dir, name));
      } catch {
        // 일부 파일이 동기화 중이면 다음 파일을 계속 확인합니다.
      }
    }
    return { path: dir, exists: true, fileCount: names.length };
  } catch {
    return { path: dir, exists: false, fileCount: 0 };
  }
}

// [성능] 주기 폴링(records_list)마다 8개 폴더 스캔+로그 기록을 하던 것을 10초에 1회로 제한.
// 기록 저장/폴더 검증처럼 즉시성이 필요한 이벤트는 스로틀을 우회한다.
let lastPokeScanAt = 0;
const POKE_SCAN_MIN_INTERVAL_MS = 10000;

export function pokeOneDriveSync(ctx: RuntimeContext, reason = "refresh"): {
  ok: boolean;
  heartbeatPath: string;
  scanned: Array<{ path: string; exists: boolean; fileCount: number }>;
} {
  const config = normalizeOneDriveConfig(syncConfigFromActiveSession(ctx));
  Object.assign(ctx.config, config);
  if (!usesOneDriveJson(ctx) || !config.oneDriveRoot || !config.sessionDataRoot) {
    return { ok: false, heartbeatPath: "", scanned: [] };
  }

  const urgent = reason === "record_saved" || reason === "validate_setup";
  const now = Date.now();
  if (!urgent && now - lastPokeScanAt < POKE_SCAN_MIN_INTERVAL_MS) {
    return { ok: true, heartbeatPath: "", scanned: [] };
  }
  lastPokeScanAt = now;

  const scanned = [
    scanDirectoryForOneDrive(config.oneDriveRoot),
    scanDirectoryForOneDrive(recordBaseRoot(config)),
    scanDirectoryForOneDrive(config.sessionDataRoot),
    scanDirectoryForOneDrive(config.typingIncomingPath),
    scanDirectoryForOneDrive(config.aiIncomingPath),
    scanDirectoryForOneDrive(adminActionsDir(config)),
    scanDirectoryForOneDrive(config.exportPath),
    scanDirectoryForOneDrive(config.logsPath)
  ];

  return { ok: true, heartbeatPath: "", scanned };
}

export function cleanupLegacyOneDriveArtifacts(ctx: RuntimeContext): OneDriveCleanupResult {
  const config = normalizeOneDriveConfig(syncConfigFromActiveSession(ctx));
  Object.assign(ctx.config, config);
  assertOneDriveReady(ctx);

  // 새 상태 파일을 먼저 보장한 뒤 구버전 누적 파일만 정리한다.
  writeActiveSessionMarker(ctx, config);
  const activeSnapshotReady = fs.existsSync(activeSessionSnapshotsDir(config));
  const stageSnapshotDir = stageTextSnapshotsDir(config);
  const stageSnapshotReady = Boolean(
    stageSnapshotDir &&
      fs.existsSync(stageSnapshotDir) &&
      fs.readdirSync(stageSnapshotDir).some((name) => name.toLowerCase().endsWith(".csv"))
  );

  const targets: Array<{ dir: string; extensions: string[]; enabled: boolean }> = [
    { dir: rootActiveSessionEventsDir(config), extensions: [".json", ".tmp"], enabled: activeSnapshotReady },
    { dir: activeSessionEventsDir(config), extensions: [".json", ".tmp"], enabled: activeSnapshotReady },
    { dir: sharedStageTextsVersionsDir(config), extensions: [".csv", ".tmp"], enabled: stageSnapshotReady },
    { dir: config.logsPath, extensions: [".log", ".tmp"], enabled: true },
    { dir: path.join(config.sessionDataRoot, "_sync"), extensions: [".json", ".tmp"], enabled: true }
  ];
  const scannedDirectories: string[] = [];
  let deletedFileCount = 0;
  let deletedBytes = 0;
  let failedFileCount = 0;
  for (const target of targets) {
    if (!target.enabled || !target.dir || !fs.existsSync(target.dir)) continue;
    scannedDirectories.push(target.dir);
    for (const name of fs.readdirSync(target.dir)) {
      const filePath = path.join(target.dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || !target.extensions.some((extension) => name.toLowerCase().endsWith(extension))) continue;
        fs.unlinkSync(filePath);
        deletedFileCount += 1;
        deletedBytes += stat.size;
      } catch {
        failedFileCount += 1;
      }
    }
  }
  writeOperationalLog(ctx, {
    action: "legacy_onedrive_artifacts_cleanup",
    result: failedFileCount === 0 ? "success" : "partial",
    details: { deletedFileCount, deletedBytes, failedFileCount, scannedDirectories }
  });
  return { deletedFileCount, deletedBytes, failedFileCount, scannedDirectories };
}

function ensureRecordsFile(filePath: string, notices: string[]): void {
  if (!fs.existsSync(filePath)) {
    writeCsvAtomic(filePath, [], RECORD_HEADERS as unknown as string[]);
    notices.push("기록 파일이 없어 새로 생성합니다.");
    return;
  }
  ensureCsvColumns(filePath, RECORD_HEADERS);
}

function ensureStageTextsFile(filePath: string, notices: string[]): void {
  if (fs.existsSync(filePath)) {
    ensureCsvColumns(filePath, STAGE_TEXT_HEADERS);
    ensureStageTextModeRows(filePath);
    return;
  }
  const created = nowIso();
  const rows = createDefaultStageTextRows(created);
  writeCsvAtomic(filePath, rows, STAGE_TEXT_HEADERS as unknown as string[]);
  notices.push("문구 파일이 없어 기본 문구로 생성합니다.");
}

function createDefaultStageTextRows(created: string): StageText[] {
  let id = 0;
  return (["normal", "ai_challenge"] as const).flatMap((gameMode) =>
    DEFAULT_STAGE_TEXTS_BY_STAGE.flatMap<StageText>((texts, stageIndex) =>
      texts.map((text) => ({
        id: String((id += 1)),
        game_mode: gameMode,
        stage_number: String(stageIndex + 1),
        text,
        is_active: "true",
        created_at: created,
        updated_at: created
      }))
    )
  );
}

function ensureStageTextModeRows(filePath: string): void {
  const created = nowIso();
  const original = readCsv<StageText>(filePath, STAGE_TEXT_HEADERS, false);
  const rows = original.map(normalizeStageTextRow);
  let changed = rows.some(
    (row, index) => row.game_mode !== original[index].game_mode || row.is_active !== original[index].is_active
  );
  let maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);

  for (const gameMode of ["normal", "ai_challenge"] as const) {
    for (let stage = 1; stage <= 3; stage += 1) {
      const hasRows = rows.some(
        (row) => normalizeStageTextMode(row.game_mode) === gameMode && row.stage_number === String(stage)
      );
      if (hasRows) continue;
      const source =
        rows.find((row) => normalizeStageTextMode(row.game_mode) === "normal" && row.stage_number === String(stage)) ??
        rows.find((row) => row.stage_number === String(stage));
      rows.push({
        id: String((maxId += 1)),
        game_mode: gameMode,
        stage_number: String(stage),
        text: source?.text || DEFAULT_STAGE_TEXTS_BY_STAGE[stage - 1][0],
        is_active: "true",
        created_at: created,
        updated_at: created
      });
      changed = true;
    }
  }

  if (changed) writeCsvAtomic(filePath, rows, STAGE_TEXT_HEADERS);
}

function ensureAuditFile(filePath: string): void {
  if (!fs.existsSync(filePath)) writeCsvAtomic(filePath, [], AUDIT_HEADERS as unknown as string[]);
  else ensureCsvColumns(filePath, AUDIT_HEADERS);
}

function ensureCsvColumns(filePath: string, headers: readonly string[]): void {
  const content = fs.readFileSync(filePath, "utf8");
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  const current = firstLine.split(",").map((value) => normalizeCsvHeader(value));
  if (headers.every((header) => current.includes(header))) {
    const labels = labelMapFor(headers);
    const expectedLabelLine = headers.map((header) => labels[header] ?? header).join(",");
    if (firstLine !== expectedLabelLine) {
      const rows = parse(content, {
        bom: true,
        columns: (columns: string[]) => columns.map((header) => normalizeCsvHeader(header)),
        skip_empty_lines: true
      }) as Record<string, string>[];
      writeCsvAtomic(filePath, rows, headers);
    }
    return;
  }
  const rows = parse(content, {
    bom: true,
    columns: (columns: string[]) => columns.map((header) => normalizeCsvHeader(header)),
    skip_empty_lines: true
  }) as Record<string, string>[];
  const migrated = rows.map((row) =>
    Object.fromEntries(headers.map((header) => [header, row[header] ?? ""]))
  );
  writeCsvAtomic(filePath, migrated, headers);
}

function assertHeaders(content: string, headers: readonly string[]): void {
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  const current = firstLine.split(",").map((value) => normalizeCsvHeader(value));
  const missing = headers.filter((header) => !current.includes(header));
  if (missing.length > 0) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);
}

function normalizeCsvHeader(header: string): string {
  const value = header.replace(/^\uFEFF/, "").trim();
  return CSV_HEADER_KEYS[value] ?? value;
}

function readCsv<T extends object>(
  filePath: string,
  headers: readonly string[],
  respectLock = true
): T[] {
  if (respectLock && isLocked(filePath)) {
    const error = new Error("기록 파일을 다른 작업에서 사용 중입니다. 잠시 후 다시 시도합니다.");
    error.name = "LOCKED";
    throw error;
  }
  const content = fs.readFileSync(filePath, "utf8");
  assertHeaders(content, headers);
  return parse(content, {
    bom: true,
    columns: (headers: string[]) => headers.map((header) => normalizeCsvHeader(header)),
    skip_empty_lines: true,
    relax_quotes: false
  }) as unknown as T[];
}

function csvText<T extends object>(rows: T[], headers: readonly string[]): string {
  const labels = labelMapFor(headers);
  return (
    BOM +
    stringify(rows, {
      header: true,
      columns: headers.map((header) => ({
        key: header,
        header: labels[header] ?? CSV_HEADER_LABELS[header] ?? header
      })),
      record_delimiter: "\r\n",
      quoted_match: /[",\r\n]/
    })
  );
}

function labelMapFor(headers: readonly string[]): Record<string, string> {
  if (headers.includes(EXPORT_RANK_HEADER)) return CSV_HEADER_LABELS;
  if (headers.includes("record_id")) return RECORD_HEADER_LABELS;
  if (headers.includes("audit_id")) return AUDIT_HEADER_LABELS;
  if (headers.includes("stage_number")) return STAGE_TEXT_HEADER_LABELS;
  return CSV_HEADER_LABELS;
}

function writeCsvAtomic<T extends object>(
  filePath: string,
  rows: T[],
  headers: readonly string[]
): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, csvText(rows, headers), "utf8");
  fs.renameSync(tempPath, filePath);
}

function isLocked(filePath: string): boolean {
  return fs.existsSync(`${filePath}.lock`);
}

async function withFileLock<T>(filePath: string, task: () => Promise<T> | T): Promise<T> {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
  const release = await lockfile.lock(filePath, {
    realpath: false,
    retries: {
      retries: 8,
      minTimeout: 80,
      maxTimeout: 400,
      factor: 1.2
    }
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

function usesOneDriveJson(ctx: RuntimeContext): boolean {
  return ctx.config.syncMode === "onedrive_manual";
}

function assertOneDriveReady(ctx: RuntimeContext): void {
  const config = normalizeOneDriveConfig(ctx.config);
  Object.assign(ctx.config, config);
  if (!config.oneDriveRoot) throw new Error(ONEDRIVE_ROOT_REQUIRED_CLEAN);
  if (!config.dayNo || !config.roundNo) throw new Error(DAY_ROUND_REQUIRED_CLEAN);
  if (!config.setupComplete) throw new Error(START_SETUP_REQUIRED_CLEAN);
}

function directoryExists(dir: string): boolean {
  try {
    return Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function checkGameStartReadiness(
  ctx: RuntimeContext,
  gameMode: "normal" | "ai_challenge" = "normal",
  syncActiveSession = true
): GameStartReadiness {
  if (!usesOneDriveJson(ctx)) return { ready: true };
  const config = normalizeOneDriveConfig(syncActiveSession ? syncConfigFromActiveSession(ctx) : ctx.config);
  Object.assign(ctx.config, config);
  const targetPath = gameMode === "ai_challenge" ? config.aiIncomingPath : config.typingIncomingPath;
  const reasons: string[] = [];
  const activeSession = syncActiveSession ? readActiveSessionMarker(config) : null;
  let blockMessage = START_SETUP_REQUIRED_CLEAN;
  if (!config.oneDriveRoot) reasons.push("OneDrive 루트 폴더 미선택");
  if (!config.setupComplete) reasons.push("폴더 생성 및 검증 미완료");
  if (!config.sessionDataRoot) reasons.push("세션 기록 폴더 없음");
  if (!targetPath) reasons.push("현재 모드 incoming 경로 없음");
  if (targetPath && !directoryExists(targetPath)) reasons.push("현재 모드 incoming 폴더 없음");
  // 연습모드는 공식 회차와 무관하므로 운영 세션 불일치 검사를 하지 않는다.
  if (!practiceSessionMode && activeSession && isActiveSessionMismatch(activeSession, config)) {
    reasons.push("현재 운영 세션 불일치");
    blockMessage = activeSessionMismatchMessage(activeSession);
  }

  if (reasons.length > 0) {
    writeOperationalLog(ctx, {
      level: "warn",
      action: "game_start_blocked",
      targetPath,
      result: "blocked",
      details: {
        gameMode,
        reasons,
        activeSession: activeSession
          ? { dayNo: activeSession.day_no, roundNo: activeSession.round_no }
          : null
      }
    });
    return { ready: false, message: blockMessage, reasons };
  }

  writeOperationalLog(ctx, {
    action: "game_start_allowed",
    targetPath,
    result: "ok",
    details: { gameMode }
  });
  return { ready: true };
}

function normalizeGeumcheonFairness(value: unknown): GeumcheonFairnessInput | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const totalUserTimeMs = source.totalUserTimeMs;
  if (typeof source.catalogVersion !== "string" || typeof totalUserTimeMs !== "number" || !Number.isSafeInteger(totalUserTimeMs) || totalUserTimeMs < 0 || !Array.isArray(source.stages) || source.stages.length < 1 || source.stages.length > 3) {
    return undefined;
  }
  const stages = source.stages.map((value, index) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const stage = value as Record<string, unknown>;
    if (
      stage.stageNumber !== index + 1 ||
      typeof stage.textId !== "string" ||
      typeof stage.catalogVersion !== "string" ||
      stage.catalogVersion !== source.catalogVersion ||
      typeof stage.targetText !== "string" ||
      typeof stage.typedText !== "string" ||
      typeof stage.userTimeMs !== "number" || !Number.isSafeInteger(stage.userTimeMs) || stage.userTimeMs < 0 ||
      typeof stage.typingUnits !== "number" || !Number.isSafeInteger(stage.typingUnits) || stage.typingUnits < 0 ||
      typeof stage.aiCpm !== "number" || !Number.isSafeInteger(stage.aiCpm) || stage.aiCpm < 1 ||
      (stage.result !== "USER_WIN" && stage.result !== "AI_WIN" && stage.result !== "INTERRUPTED")
    ) return undefined;
    return {
      stageNumber: stage.stageNumber as 1 | 2 | 3,
      textId: stage.textId,
      catalogVersion: stage.catalogVersion,
      targetText: stage.targetText,
      typedText: stage.typedText,
      userTimeMs: Number(stage.userTimeMs),
      typingUnits: Number(stage.typingUnits),
      aiCpm: Number(stage.aiCpm),
      result: stage.result
    };
  });
  if (stages.some((stage) => stage === undefined)) return undefined;
  const validStages = stages as GeumcheonFairnessInput["stages"];
  if (calculateTotalUserTimeMs(validStages.map((stage) => stage.userTimeMs)) !== totalUserTimeMs) return undefined;
  return { catalogVersion: source.catalogVersion, totalUserTimeMs, stages: validStages };
}

function normalizeJsonRecord(value: unknown): RecordRow | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const row = Object.fromEntries(
    RECORD_HEADERS.map((header) => [header, source[header] == null ? "" : String(source[header])])
  ) as unknown as RecordRow;
  const fairness = normalizeGeumcheonFairness(source.fairness);
  const canonicalAttempt = isCanonicalAiAttemptV1(source.canonicalAttempt)
    ? source.canonicalAttempt
    : undefined;
  return row.record_id
    ? {
        ...row,
        ...(fairness ? { fairness } : {}),
        ...(canonicalAttempt ? { canonicalAttempt } : {})
      }
    : null;
}

function isSupportedRecordMode(value: string): value is RecordMode {
  return value === "normal" || value === "ai_challenge";
}

function isUsableLeaderboardRecord(row: RecordRow, expectedMode?: RecordMode): boolean {
  const rawMode = String(row.game_mode ?? "").trim();
  const mode = rawMode === "" && expectedMode === "normal" ? "normal" : rawMode;
  if (!isSupportedRecordMode(mode)) return false;
  if (expectedMode && mode !== expectedMode) return false;
  if (!String(row.record_id ?? "").trim() || !String(row.participant_name ?? "").trim()) return false;
  const totalTimeMs = Number(row.total_time_ms);
  return Number.isFinite(totalTimeMs) && (totalTimeMs > 0 || isInterruptedRecord(row));
}

// [성능] 기록/조치 JSON은 원자적 rename으로만 교체되므로 mtime+size가 같으면 내용이 같다.
// 리더보드가 1~2초마다 전체 폴더를 재파싱하며 메인 프로세스를 블로킹하던 것을,
// 변경된 파일만 다시 읽도록 캐시한다(구형 노트북 응답없음 완화). 반환은 복사본이라 캐시 오염 없음.
type JsonCacheEntry<T> = { mtimeMs: number; size: number; value: T | null };
const recordJsonCache = new Map<string, JsonCacheEntry<RecordRow>>();
const adminActionJsonCache = new Map<string, JsonCacheEntry<AdminAction>>();
type RecordDirectoryCacheEntry = {
  mtimeMs: number;
  fileCount: number;
  validRows: RecordRow[];
  ignoredFileCount: number;
};
const recordDirectoryCache = new Map<string, RecordDirectoryCacheEntry>();
type AdminActionDirectoryCacheEntry = {
  mtimeMs: number;
  fileCount: number;
  actions: AdminAction[];
};
const adminActionDirectoryCache = new Map<string, AdminActionDirectoryCacheEntry>();

function readRecordJsonCached(filePath: string): RecordRow | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = recordJsonCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value ? { ...hit.value } : null;
  }
  let value: RecordRow | null = null;
  try {
    value = normalizeJsonRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    value = null;
  }
  recordJsonCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value ? { ...value } : null;
}

function readAdminActionJsonCached(filePath: string): AdminAction | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = adminActionJsonCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value ? { ...hit.value } : null;
  }
  let value: AdminAction | null = null;
  try {
    value = normalizeAdminAction(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    value = null;
  }
  adminActionJsonCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value ? { ...value } : null;
}
function readRecordDirectorySnapshot(dir: string, expectedMode: RecordMode): RecordDirectoryCacheEntry {
  if (!dir || !fs.existsSync(dir)) {
    return { mtimeMs: 0, fileCount: 0, validRows: [], ignoredFileCount: 0 };
  }
  const names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"));
  const mtimeMs = fs.statSync(dir).mtimeMs;
  const cacheKey = `${expectedMode}|${dir}`;
  const hit = recordDirectoryCache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs && hit.fileCount === names.length) {
    return { ...hit, validRows: hit.validRows.map((row) => ({ ...row })) };
  }
  const validRows: RecordRow[] = [];
  let ignoredFileCount = 0;
  for (const name of names) {
    const row = readRecordJsonCached(path.join(dir, name));
    if (row && isUsableLeaderboardRecord(row, expectedMode)) {
      validRows.push({ ...row, game_mode: expectedMode });
    } else {
      ignoredFileCount += 1;
    }
  }
  const next = { mtimeMs, fileCount: names.length, validRows, ignoredFileCount };
  recordDirectoryCache.set(cacheKey, next);
  return { ...next, validRows: validRows.map((row) => ({ ...row })) };
}

function readJsonRecordsFromDir(dir: string, expectedMode: RecordMode): RecordRow[] {
  return readRecordDirectorySnapshot(dir, expectedMode).validRows;
}

function readJsonRecordsFromDirWithStats(dir: string, expectedMode: RecordMode): {
  sourceFileCount: number;
  validRows: RecordRow[];
  ignoredFileCount: number;
} {
  const snapshot = readRecordDirectorySnapshot(dir, expectedMode);
  return {
    sourceFileCount: snapshot.fileCount,
    validRows: snapshot.validRows,
    ignoredFileCount: snapshot.ignoredFileCount
  };
}

function dedupeRecords(rows: RecordRow[]): RecordRow[] {
  const byId = new Map<string, RecordRow>();
  rows.forEach((row) => {
    if (!byId.has(row.record_id)) byId.set(row.record_id, row);
  });
  return [...byId.values()];
}

function readOneDriveJsonRecords(ctx: RuntimeContext): RecordRow[] {
  assertOneDriveReady(ctx);
  try {
    return applyAdminActions(ctx, [
      ...readJsonRecordsFromDir(ctx.config.typingIncomingPath, "normal"),
      ...readJsonRecordsFromDir(ctx.config.aiIncomingPath, "ai_challenge")
    ]);
  } catch {
    throw new Error(LEADERBOARD_READ_FAILED_CLEAN);
  }
}

export function readRecords(ctx: RuntimeContext): RecordRow[] {
  if (usesOneDriveJson(ctx)) return readOneDriveJsonRecords(ctx);
  return readCsv<RecordRow>(ctx.paths.recordsFile, RECORD_HEADERS);
}

export function getLeaderboardSyncStatus(ctx: RuntimeContext, gameMode?: "normal" | "ai_challenge"): LeaderboardSyncStatus {
  const mode = normalizeRecordMode(gameMode);
  const base = {
    sessionName: ctx.config.sessionName || `${ctx.config.dayNo}일차 ${ctx.config.roundNo}회차`,
    dayNo: ctx.config.dayNo,
    roundNo: ctx.config.roundNo,
    lastReadAt: nowIso(),
    sourceFileCount: 0,
    reflectedRecordCount: 0,
    ignoredFileCount: 0
  };
  if (!usesOneDriveJson(ctx) || !ctx.config.setupComplete) {
    return { ...base, status: "오류", error: SETUP_REQUIRED_CLEAN };
  }
  try {
    const dir = mode === "ai_challenge" ? ctx.config.aiIncomingPath : ctx.config.typingIncomingPath;
    const stats = readJsonRecordsFromDirWithStats(dir, mode);
    const reflectedRecordCount = applyAdminActions(ctx, stats.validRows)
      .filter((record) => record.is_test !== "true" && record.is_debug !== "true")
      .length;
    const ignoredFileCount = stats.ignoredFileCount;
    const status =
      stats.sourceFileCount === 0
        ? "기록 없음"
        : ignoredFileCount > 0
          ? "주의"
          : "정상";
    return {
      ...base,
      sourceFileCount: stats.sourceFileCount,
      reflectedRecordCount,
      ignoredFileCount,
      status
    };
  } catch (error) {
    return {
      ...base,
      status: "오류",
      error: error instanceof Error ? error.message : LEADERBOARD_READ_FAILED_CLEAN
    };
  }
}

function localStageTextsDirtyPath(ctx: RuntimeContext): string {
  return `${ctx.paths.stageTextsFile}.local_dirty`;
}

function markStageTextsDirty(ctx: RuntimeContext): void {
  fs.writeFileSync(localStageTextsDirtyPath(ctx), nowIso(), "utf8");
}

function clearStageTextsDirty(ctx: RuntimeContext): void {
  const filePath = localStageTextsDirtyPath(ctx);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function latestSharedStageTextsPath(config: AppConfig): string {
  const snapshotsDir = stageTextSnapshotsDir(config);
  if (snapshotsDir && fs.existsSync(snapshotsDir)) {
    const snapshots = fs
      .readdirSync(snapshotsDir)
      .filter((name) => name.toLowerCase().endsWith(".csv"))
      .map((name) => {
        const filePath = path.join(snapshotsDir, name);
        try {
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs, name };
        } catch {
          return null;
        }
      })
      .filter((item): item is { filePath: string; mtimeMs: number; name: string } => item != null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    if (snapshots.length > 0) return snapshots[0].filePath;
  }

  // 새 장치별 스냅샷이 만들어지기 전까지만 기존 누적형 버전을 읽는다.
  const versionsDir = sharedStageTextsVersionsDir(config);
  if (versionsDir && fs.existsSync(versionsDir)) {
    const candidates = fs
      .readdirSync(versionsDir)
      .filter((name) => name.toLowerCase().endsWith(".csv"))
      .sort((a, b) => b.localeCompare(a));
    if (candidates.length > 0) return path.join(versionsDir, candidates[0]);
  }
  return sharedStageTextsPath(config);
}

function syncStageTextsFromShared(ctx: RuntimeContext): void {
  const sharedPath = latestSharedStageTextsPath(ctx.config);
  if (!sharedPath || !fs.existsSync(sharedPath)) return;
  try {
    const localPath = ctx.paths.stageTextsFile;
    const sharedStat = fs.statSync(sharedPath);
    const dirtyPath = localStageTextsDirtyPath(ctx);
    if (fs.existsSync(dirtyPath)) {
      const dirtyStat = fs.statSync(dirtyPath);
      if (dirtyStat.mtimeMs >= sharedStat.mtimeMs - 500) return;
    }
    const localHash = fs.existsSync(localPath) ? hashFile(localPath) : "";
    const sharedHash = hashFile(sharedPath);
    if (localHash === sharedHash) {
      clearStageTextsDirty(ctx);
      return;
    }
    const rows = readCsv<StageText>(sharedPath, STAGE_TEXT_HEADERS, false).map(normalizeStageTextRow);
    writeCsvAtomic(localPath, rows, STAGE_TEXT_HEADERS);
    clearStageTextsDirty(ctx);
    writeOperationalLog(ctx, {
      action: "stage_texts_synced_from_onedrive",
      sourcePath: sharedPath,
      targetPath: localPath,
      result: "success",
      details: { count: rows.length, hash: sharedHash }
    });
  } catch (error) {
    writeOperationalLog(ctx, {
      level: "warn",
      action: "stage_texts_sync_from_onedrive_failed",
      sourcePath: sharedPath,
      result: "failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
}

export function readStageTexts(ctx: RuntimeContext): StageText[] {
  syncStageTextsFromShared(ctx);
  return readCsv<StageText>(ctx.paths.stageTextsFile, STAGE_TEXT_HEADERS).map(normalizeStageTextRow);
}

export async function publishStageTextsToOneDrive(ctx: RuntimeContext): Promise<StageTextPublishResult> {
  if (practiceSessionMode) throw new Error(PRACTICE_STAGE_TEXT_READONLY);
  const snapshotsDir = stageTextSnapshotsDir(ctx.config);
  if (!snapshotsDir) throw new Error("OneDrive 루트 폴더와 기록 기본 폴더명을 먼저 설정해 주세요.");
  return withFileLock(ctx.paths.stageTextsFile, () => {
    const rows = readCsv<StageText>(ctx.paths.stageTextsFile, STAGE_TEXT_HEADERS, false).map(normalizeStageTextRow);
    const sharedPath = path.join(
      snapshotsDir,
      deviceScopedFileName("stage_texts", ctx.config, "csv")
    );
    const localHash = hashFile(ctx.paths.stageTextsFile);
    if (fs.existsSync(sharedPath)) {
      try {
        if (hashFile(sharedPath) === localHash) {
          clearStageTextsDirty(ctx);
          return { filePath: sharedPath, count: rows.length, hash: localHash, updatedAt: nowIso() };
        }
      } catch {
        // 손상되었거나 동기화 중인 자기 스냅샷은 아래 원자적 저장으로 교체한다.
      }
    }
    writeCsvAtomic(sharedPath, rows, STAGE_TEXT_HEADERS);
    const hash = hashFile(sharedPath);
    const updatedAt = nowIso();
    clearStageTextsDirty(ctx);
    writeOperationalLog(ctx, {
      action: "stage_texts_published_to_onedrive",
      targetPath: sharedPath,
      result: "success",
      details: { count: rows.length, hash, mode: "device_snapshot" }
    });
    return { filePath: sharedPath, count: rows.length, hash, updatedAt };
  });
}

export function getCleanLeaderboardSyncStatus(
  ctx: RuntimeContext,
  gameMode?: "normal" | "ai_challenge"
): LeaderboardSyncStatus {
  const mode = normalizeRecordMode(gameMode);
  const base = {
    sessionName: ctx.config.sessionName || `${ctx.config.dayNo}일차 ${ctx.config.roundNo}회차`,
    dayNo: ctx.config.dayNo,
    roundNo: ctx.config.roundNo,
    lastReadAt: nowIso(),
    sourceFileCount: 0,
    reflectedRecordCount: 0,
    ignoredFileCount: 0
  };
  if (!usesOneDriveJson(ctx) || !ctx.config.setupComplete) {
    return { ...base, status: "오류" as LeaderboardSyncStatus["status"], error: START_SETUP_REQUIRED_CLEAN };
  }
  try {
    const dir = mode === "ai_challenge" ? ctx.config.aiIncomingPath : ctx.config.typingIncomingPath;
    const stats = readJsonRecordsFromDirWithStats(dir, mode);
    const reflectedRecordCount = readRecords(ctx)
      .filter((record) => normalizeRecordMode(record.game_mode) === mode)
      .filter((record) => record.is_test !== "true" && record.is_debug !== "true")
      .length;
    const status =
      stats.sourceFileCount === 0
        ? "기록 없음"
        : stats.ignoredFileCount > 0
          ? "주의"
          : "정상";
    return {
      ...base,
      sourceFileCount: stats.sourceFileCount,
      reflectedRecordCount,
      ignoredFileCount: stats.ignoredFileCount,
      status: status as LeaderboardSyncStatus["status"]
    };
  } catch (error) {
    return {
      ...base,
      status: "오류" as LeaderboardSyncStatus["status"],
      error: error instanceof Error ? error.message : LEADERBOARD_READ_FAILED_CLEAN
    };
  }
}

function normalizeStageTextMode(value?: string): "normal" | "ai_challenge" {
  return value === "ai_challenge" ? "ai_challenge" : "normal";
}

function normalizeStageTextRow(row: StageText): StageText {
  return {
    ...row,
    game_mode: normalizeStageTextMode(row.game_mode),
    is_active: row.is_active === "false" ? "false" : "true"
  };
}

export function validateStageReadiness(ctx: RuntimeContext, gameMode = "normal"): string[] {
  const rows = readStageTexts(ctx);
  const normalizedMode = normalizeStageTextMode(gameMode);
  const errors: string[] = [];
  for (let stage = 1; stage <= ctx.config.stageCount; stage += 1) {
    const activeCount = rows.filter(
      (row) =>
        row.stage_number === String(stage) &&
        row.is_active === "true" &&
        normalizeStageTextMode(row.game_mode) === normalizedMode
    ).length;
    if (activeCount === 0) errors.push(`Stage ${stage}에 등록된 활성 문구가 없습니다.`);
  }
  return errors;
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|！!?？\s]+/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "PC";
}

function createOneDriveRecordId(ctx: RuntimeContext, gameMode: string): string {
  const modeLabel = gameMode === "ai_challenge" ? "ai" : "typing";
  const pcId = safeFilePart(ctx.config.pcId || DEFAULT_CONFIG.pcId);
  return `${timestampForFile()}_${pcId}_${modeLabel}_${crypto.randomBytes(4).toString("hex")}`;
}

function oneDriveIncomingDir(ctx: RuntimeContext, gameMode: string): string {
  return gameMode === "ai_challenge" ? ctx.config.aiIncomingPath : ctx.config.typingIncomingPath;
}

function adminActionsDir(config: AppConfig): string {
  return config.sessionDataRoot ? path.join(config.sessionDataRoot, "admin_actions") : "";
}

function normalizeAdminAction(value: unknown): AdminAction | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const actionType = String(source.action_type ?? "");
  if (!["hide", "edit", "reset_session"].includes(actionType)) return null;
  const actionId = String(source.action_id ?? "");
  if (!actionId) return null;
  return {
    action_id: actionId,
    action_type: actionType as AdminAction["action_type"],
    target_record_id: source.target_record_id == null ? "" : String(source.target_record_id),
    created_at: String(source.created_at ?? ""),
    admin_name: source.admin_name == null ? "" : String(source.admin_name),
    admin_note: source.admin_note == null ? "" : String(source.admin_note),
    day_no: source.day_no == null ? undefined : Number(source.day_no),
    round_no: source.round_no == null ? undefined : Number(source.round_no),
    game_mode:
      source.game_mode === "ai_challenge" || source.game_mode === "normal"
        ? source.game_mode
        : undefined,
    replacement_record: source.replacement_record
  };
}

function readAdminActions(ctx: RuntimeContext): AdminAction[] {
  const dir = adminActionsDir(ctx.config);
  if (!dir || !fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"));
  const mtimeMs = fs.statSync(dir).mtimeMs;
  const hit = adminActionDirectoryCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs && hit.fileCount === names.length) {
    return hit.actions.map((action) => ({ ...action }));
  }
  const actions = names
    .flatMap((name) => {
      const action = readAdminActionJsonCached(path.join(dir, name));
      return action ? [action] : [];
    })
    .sort((a, b) => `${a.created_at}_${a.action_id}`.localeCompare(`${b.created_at}_${b.action_id}`));
  adminActionDirectoryCache.set(dir, { mtimeMs, fileCount: names.length, actions });
  return actions.map((action) => ({ ...action }));
}

function writeAdminAction(ctx: RuntimeContext, action: AdminAction): void {
  assertOneDriveReady(ctx);
  const dir = adminActionsDir(ctx.config);
  if (!dir) throw new Error(SETUP_REQUIRED_CLEAN);
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, `${safeFilePart(action.action_id)}.json`), action);
}

function createAdminActionId(actionType: AdminAction["action_type"], target = "session"): string {
  return `${actionType}_${safeFilePart(target)}_${timestampForFile()}_${crypto.randomBytes(3).toString("hex")}`;
}

function actionMatchesSession(ctx: RuntimeContext, action: AdminAction): boolean {
  if (action.day_no && Number(action.day_no) !== Number(ctx.config.dayNo)) return false;
  if (action.round_no && Number(action.round_no) !== Number(ctx.config.roundNo)) return false;
  return true;
}

function applyAdminActions(ctx: RuntimeContext, rows: RecordRow[]): RecordRow[] {
  const byId = new Map(dedupeRecords(rows).map((row) => [row.record_id, row]));
  for (const action of readAdminActions(ctx)) {
    if (!actionMatchesSession(ctx, action)) continue;
    if (action.action_type === "reset_session") {
      for (const [recordId, row] of byId) {
        const rowMode = row.game_mode === "ai_challenge" ? "ai_challenge" : "normal";
        if (!action.game_mode || action.game_mode === rowMode) byId.delete(recordId);
      }
      continue;
    }
    const targetId = action.target_record_id ?? "";
    if (!targetId) continue;
    if (action.action_type === "hide") {
      byId.delete(targetId);
      continue;
    }
    if (action.action_type === "edit") {
      byId.delete(targetId);
      const replacement = normalizeJsonRecord(action.replacement_record);
      if (replacement) byId.set(replacement.record_id, replacement);
    }
  }
  return [...byId.values()];
}

function writeJsonRecordToIncomingDir(row: RecordRow, dir: string): { filePath: string; size: number; hash: string } {
  if (!isSupportedRecordMode(row.game_mode)) throw new Error("기록의 게임 모드가 올바르지 않습니다.");
  if (!isUsableLeaderboardRecord(row, row.game_mode)) throw new Error("기록 필수 항목이 올바르지 않습니다.");
  ensureDir(dir);
  const filePath = path.join(dir, `${safeFilePart(row.record_id)}.json`);
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const parsed = normalizeJsonRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (!parsed || parsed.record_id !== row.record_id || stats.size <= 0) {
      throw new Error("같은 record_id의 기록 파일이 이미 있지만 검증에 실패했습니다.");
    }
    return { filePath, size: stats.size, hash: hashFile(filePath) };
  }
  writeJsonAtomic(filePath, row);
  const stats = fs.statSync(filePath);
  if (stats.size <= 0) throw new Error("기록 파일 크기가 0입니다.");
  const parsed = normalizeJsonRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
  if (!parsed || parsed.record_id !== row.record_id) throw new Error("기록 파일 검증에 실패했습니다.");
  return { filePath, size: stats.size, hash: hashFile(filePath) };
}

function writeOneDriveJsonRecord(ctx: RuntimeContext, row: RecordRow): { filePath: string; size: number; hash: string } {
  assertOneDriveReady(ctx);
  const dir = oneDriveIncomingDir(ctx, row.game_mode);
  if (!dir) throw new Error(START_SETUP_REQUIRED_CLEAN);
  return writeJsonRecordToIncomingDir(row, dir);
}

function queuedRecordTarget(ctx: RuntimeContext): QueuedRecordTarget {
  return {
    oneDriveRoot: ctx.config.oneDriveRoot,
    recordBaseFolderName: ctx.config.recordBaseFolderName,
    dayNo: ctx.config.dayNo,
    roundNo: ctx.config.roundNo,
    practice: practiceSessionMode
  };
}

function normalizeQueuedTarget(value: unknown): QueuedRecordTarget | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Partial<QueuedRecordTarget>;
  const oneDriveRoot = String(source.oneDriveRoot ?? "").trim();
  const recordBaseFolderName = String(source.recordBaseFolderName ?? "").trim();
  const dayNo = positiveInteger(source.dayNo, 0);
  const roundNo = positiveInteger(source.roundNo, 0);
  if (!oneDriveRoot || !recordBaseFolderName || dayNo < 1 || roundNo < 1) return null;
  return { oneDriveRoot, recordBaseFolderName, dayNo, roundNo, practice: Boolean(source.practice) };
}

function queuedIncomingDir(target: QueuedRecordTarget, mode: RecordMode): string {
  if (!directoryExists(target.oneDriveRoot)) {
    throw new Error("누락 기록이 저장될 당시의 OneDrive 루트 폴더에 접근할 수 없습니다.");
  }
  const base = path.join(target.oneDriveRoot, target.recordBaseFolderName);
  const session = target.practice
    ? path.join(base, PRACTICE_SESSION_DIR_NAME)
    : path.join(base, `${target.dayNo}일차`, `${target.roundNo}회차`);
  return path.join(session, "incoming", mode === "ai_challenge" ? "ai" : "typing");
}

function parseQueuedRecord(value: unknown): { row: RecordRow; target: QueuedRecordTarget | null } | null {
  if (value != null && typeof value === "object" && "record" in value) {
    const source = value as Partial<QueuedRecordEnvelope>;
    const row = normalizeJsonRecord(source.record);
    const target = normalizeQueuedTarget(source.target);
    return row && target ? { row, target } : null;
  }
  const legacyRow = normalizeJsonRecord(value);
  return legacyRow ? { row: legacyRow, target: null } : null;
}

function writeLocalQueue(ctx: RuntimeContext, row: RecordRow): void {
  ensureDir(ctx.paths.localQueueDir);
  const filePath = path.join(ctx.paths.localQueueDir, `queued_${timestampForFile()}_${safeFilePart(row.record_id)}.json`);
  const envelope: QueuedRecordEnvelope = {
    queue_version: 2,
    queued_at: nowIso(),
    target: queuedRecordTarget(ctx),
    record: row
  };
  writeJsonAtomic(filePath, envelope);
  writeOperationalLog(ctx, {
    level: "warn",
    action: "local_queue_saved",
    sourcePath: filePath,
    recordId: row.record_id,
    result: "queued"
  });
}

function listQueuedRecordFiles(ctx: RuntimeContext): string[] {
  if (!fs.existsSync(ctx.paths.localQueueDir)) return [];
  return fs
    .readdirSync(ctx.paths.localQueueDir)
    .filter((name) => name.toLowerCase().endsWith(".json") && !name.toLowerCase().includes(".sent"))
    .map((name) => path.join(ctx.paths.localQueueDir, name));
}

function writeQueueProcessingReceipt(
  ctx: RuntimeContext,
  input: {
    sourceFile: string;
    recordId: string;
    gameMode: string;
    targetPath: string;
    result: "success" | "failed";
    size?: number;
    hash?: string;
    errorMessage?: string;
  }
): void {
  const receipt = {
    processed_at: nowIso(),
    pc_id: ctx.config.pcId,
    pc_role: ctx.config.pcRole,
    day_no: ctx.config.dayNo,
    round_no: ctx.config.roundNo,
    source_file: input.sourceFile,
    source_file_name: path.basename(input.sourceFile),
    record_id: input.recordId,
    game_mode: input.gameMode,
    target_path: input.targetPath,
    result: input.result,
    error_message: input.errorMessage ?? "",
    file_size: input.size ?? 0,
    file_hash: input.hash ?? ""
  };
  const fileName = `${input.result === "success" ? "processed" : "recovery"}_${timestampForFile()}_${safeFilePart(input.recordId || path.basename(input.sourceFile))}.json`;
  const primaryDir = input.result === "success" ? ctx.paths.processedDir : ctx.paths.recoveryDir;
  writeJsonAtomic(path.join(primaryDir, fileName), receipt);
}

export function getQueuedRecordStatus(ctx: RuntimeContext): QueuedRecordStatus {
  return { count: listQueuedRecordFiles(ctx).length };
}

export function flushQueuedRecords(ctx: RuntimeContext): QueuedRecordFlushResult {
  const files = listQueuedRecordFiles(ctx);
  if (files.length === 0) return { attempted: 0, sent: 0, failed: 0, targetPaths: [], failures: [] };

  let sent = 0;
  let failed = 0;
  const targetPaths: string[] = [];
  const failures: Array<{ fileName: string; error: string }> = [];
  writeOperationalLog(ctx, {
    action: "queued_records_flush_start",
    result: "start",
    details: { count: files.length }
  });
  for (const file of files) {
    try {
      const queued = parseQueuedRecord(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!queued) throw new Error("누락 기록 파일 형식이 올바르지 않습니다.");
      const { row, target } = queued;
      const mode = row.game_mode === "ai_challenge" ? "ai_challenge" : row.game_mode === "normal" ? "normal" : null;
      if (!mode) throw new Error("누락 기록의 게임 모드가 올바르지 않습니다.");
      let written: { filePath: string; size: number; hash: string };
      if (target) {
        if (target.practice !== practiceSessionMode) {
          throw new Error("공식 기록과 연습 기록의 누락 기록 폴더가 일치하지 않습니다.");
        }
        written = writeJsonRecordToIncomingDir(row, queuedIncomingDir(target, mode));
      } else {
        // 구버전 큐 파일은 목적지 정보가 없으므로 현재 검증된 회차에만 보낸다.
        written = writeOneDriveJsonRecord(ctx, row);
      }
      targetPaths.push(written.filePath);
      writeQueueProcessingReceipt(ctx, {
        sourceFile: file,
        recordId: row.record_id,
        gameMode: row.game_mode,
        targetPath: written.filePath,
        result: "success",
        size: written.size,
        hash: written.hash
      });
      fs.unlinkSync(file);
      sent += 1;
      writeOperationalLog(ctx, {
        action: "queued_record_flush_success",
        sourcePath: file,
        targetPath: written.filePath,
        recordId: row.record_id,
        result: "success",
        details: { size: written.size, hash: written.hash }
      });
    } catch (error) {
      failed += 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      failures.push({ fileName: path.basename(file), error: errorMessage });
      writeQueueProcessingReceipt(ctx, {
        sourceFile: file,
        recordId: "",
        gameMode: "",
        targetPath: "",
        result: "failed",
        errorMessage
      });
      writeOperationalLog(ctx, {
        level: "error",
        action: "queued_record_flush_failed",
        sourcePath: file,
        result: "failed",
        errorMessage
      });
    }
  }
  writeOperationalLog(ctx, {
    action: "queued_records_flush_done",
    result: failed > 0 ? "partial_or_failed" : "success",
    details: { attempted: files.length, sent, failed, targetPaths }
  });
  return { attempted: files.length, sent, failed, targetPaths, failures };
}

export async function saveRecord(
  ctx: RuntimeContext,
  input: SaveRecordInput,
  stableRecordId?: string
): Promise<RecordRow> {
  const phoneError = validatePhoneParts(input.phone_part1, input.phone_part2, input.phone_part3);
  if (phoneError) throw new Error(phoneError);

  const phoneFull = buildPhoneFull(input.phone_part1, input.phone_part2, input.phone_part3);
  const fairness = input.fairness == null ? undefined : normalizeGeumcheonFairness(input.fairness);
  if (input.fairness != null && !fairness) throw new Error("금천 공정성 기록이 올바르지 않습니다.");
  const birthdate = formatBirthdate(input.birth_year, input.birth_month, input.birth_day);
  const [stage1Text, stage2Text, stage3Text] = input.stageTexts;
  const [stage1Selection, stage2Selection, stage3Selection] = input.stageTextSelections ?? [];
  const stageTextCatalogVersion = stage1Selection?.catalogVersion ?? "";
  const [stage1Time, stage2Time, stage3Time] = input.stageTimesMs;
  const charCounts = input.interruption?.stageCharCounts ?? input.stageTexts.map((text) => countTypeableChars(text));
  const totalCharCount = charCounts.reduce((sum, count) => sum + count, 0);
  const typingUnits = input.stageTexts.map((text) => countConvertedTypingUnits(text));
  const totalTypingUnits = input.interruption?.totalTypingUnits ?? typingUnits.reduce((sum, count) => sum + count, 0);
  const stage1Cumulative = stage1Time;
  const stage2Cumulative = stage1Time + stage2Time;
  const totalTime = stage1Time + stage2Time + stage3Time;
  const createdAt = nowIso();
  const completedAt = createdAt;

  const rowWithoutId: Omit<RecordRow, "record_id"> = {
    created_at: createdAt,
    completed_at: completedAt,
    participant_name: input.participant_name.trim(),
    phone_part1: input.phone_part1,
    phone_part2: input.phone_part2,
    phone_part3: input.phone_part3,
    phone_full: phoneFull,
    phone_masked: maskPhone(phoneFull),
    birth_year: input.birth_year,
    birth_month: input.birth_month.padStart(2, "0"),
    birth_day: input.birth_day.padStart(2, "0"),
    birthdate,
    birthdate_masked: maskBirthdate(birthdate),
    privacy_agreed: input.privacy_agreed ? "true" : "false",
    privacy_agreed_at: input.privacy_agreed_at,
    stage1_text: stage1Text,
    stage2_text: stage2Text,
    stage3_text: stage3Text,
    stage_text_catalog_version: stageTextCatalogVersion,
    stage1_text_id: stage1Selection?.id ?? "",
    stage2_text_id: stage2Selection?.id ?? "",
    stage3_text_id: stage3Selection?.id ?? "",
    stage1_char_count: String(charCounts[0]),
    stage2_char_count: String(charCounts[1]),
    stage3_char_count: String(charCounts[2]),
    total_char_count: String(totalCharCount),
    stage1_time_ms: String(Math.round(stage1Time)),
    stage2_time_ms: String(Math.round(stage2Time)),
    stage3_time_ms: String(Math.round(stage3Time)),
    stage1_cumulative_ms: String(Math.round(stage1Cumulative)),
    stage2_cumulative_ms: String(Math.round(stage2Cumulative)),
    total_time_ms: String(Math.round(totalTime)),
    display_stage1_sec: formatMs(stage1Time),
    display_stage2_sec: formatMs(stage2Time),
    display_stage3_sec: formatMs(stage3Time),
    display_total_sec: formatMs(totalTime),
    final_cpm:
      input.game_mode === "ai_challenge" && input.ai?.display?.participantAvgCpm != null
        ? String(Math.round(input.ai.display.participantAvgCpm))
        : String(calculateFinalCpm(totalTypingUnits, totalTime)),
    final_accuracy: String(input.final_accuracy ?? 100),
    app_version: APP_VERSION,
    is_test: input.is_test ? "true" : "false",
    is_debug: input.is_debug ? "true" : "false",
    debug_mode_type: input.debug_mode_type ?? "",
    memo:
      input.memo ??
      (input.interruption
        ? `사용자 중단:${
            input.interruption.action === "home"
              ? "메인화면"
              : input.interruption.action === "retry"
                ? "다시하기"
                : "프로그램 종료"
          }`
        : ""),
    game_mode: input.game_mode ?? "normal",
    ai_enabled: input.game_mode === "ai_challenge" ? "true" : "false",
    ai_challenge_status: input.ai?.status ?? "",
    ai_failed_stage: input.ai?.failedStage ?? "",
    ai_stage1_cpm: input.ai?.stageCpms[0] == null ? "" : String(input.ai.stageCpms[0]),
    ai_stage2_cpm: input.ai?.stageCpms[1] == null ? "" : String(input.ai.stageCpms[1]),
    ai_stage3_cpm: input.ai?.stageCpms[2] == null ? "" : String(input.ai.stageCpms[2]),
    ai_stage1_time_ms: input.ai?.stageTimesMs[0] == null ? "" : String(Math.round(input.ai.stageTimesMs[0] ?? 0)),
    ai_stage2_time_ms: input.ai?.stageTimesMs[1] == null ? "" : String(Math.round(input.ai.stageTimesMs[1] ?? 0)),
    ai_stage3_time_ms: input.ai?.stageTimesMs[2] == null ? "" : String(Math.round(input.ai.stageTimesMs[2] ?? 0)),
    ai_total_time_ms:
      input.ai == null
        ? ""
        : String(
            Math.round(
              input.ai.stageTimesMs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
            )
          ),
    stage1_vs_ai_result: input.ai?.stageResults[0] ?? "",
    stage2_vs_ai_result: input.ai?.stageResults[1] ?? "",
    stage3_vs_ai_result: input.ai?.stageResults[2] ?? "",
    final_vs_ai_result: input.ai?.finalResult ?? "",
    stage1_time_diff_ms: input.ai?.stageDiffsMs[0] == null ? "" : String(Math.round(input.ai.stageDiffsMs[0] ?? 0)),
    stage2_time_diff_ms: input.ai?.stageDiffsMs[1] == null ? "" : String(Math.round(input.ai.stageDiffsMs[1] ?? 0)),
    stage3_time_diff_ms: input.ai?.stageDiffsMs[2] == null ? "" : String(Math.round(input.ai.stageDiffsMs[2] ?? 0)),
    final_time_diff_ms: input.ai?.finalDiffMs == null ? "" : String(Math.round(input.ai.finalDiffMs)),
    participant_result_time_ms:
      input.ai?.display?.participantResultTimeMs == null ? "" : String(Math.round(input.ai.display.participantResultTimeMs)),
    ai_result_time_ms: input.ai?.display?.aiResultTimeMs == null ? "" : String(Math.round(input.ai.display.aiResultTimeMs)),
    participant_avg_cpm:
      input.ai?.display?.participantAvgCpm == null ? "" : String(Math.round(input.ai.display.participantAvgCpm)),
    ai_avg_cpm: input.ai?.display?.aiAvgCpm == null ? "" : String(Math.round(input.ai.display.aiAvgCpm)),
    challenge_result_label: input.ai?.display?.resultLabel ?? (input.interruption ? "중단" : ""),
    participant_progress_percent:
      input.ai?.display?.participantProgressPercent != null
        ? String(round1(input.ai.display.participantProgressPercent))
        : input.interruption
          ? String(round1(input.interruption.participantProgressPercent))
          : "",
    ai_progress_percent:
      input.ai?.display?.aiProgressPercent == null ? "" : String(round1(input.ai.display.aiProgressPercent)),
    duel_time_ms: input.ai?.display?.duelTimeMs == null ? "" : String(Math.round(input.ai.display.duelTimeMs)),
    result_stage:
      input.ai?.display?.resultStage != null
        ? String(input.ai.display.resultStage)
        : input.interruption
          ? String(input.interruption.resultStage)
          : "",
    original_record_id: "",
    is_admin_edited: "false",
    ...(fairness ? { fairness } : {})
  };

  if (usesOneDriveJson(ctx)) {
    const row: RecordRow = {
      record_id: stableRecordId ?? createOneDriveRecordId(ctx, rowWithoutId.game_mode),
      ...rowWithoutId
    };
    // 설정 자체가 한 번도 검증되지 않은 상태에서는 게임 시작부터 차단하며 큐를 만들지 않는다.
    // 반대로 검증 후 게임 도중 폴더가 사라진 경우에는 아래 catch에서 기록을 로컬 큐에 보존한다.
    if (!ctx.config.setupComplete || !ctx.config.oneDriveRoot || !ctx.config.sessionDataRoot) {
      throw new Error(START_SETUP_REQUIRED_CLEAN);
    }
    try {
      // 게임 시작 뒤 다른 PC에서 회차를 바꾸더라도 진행 중인 기록은 시작 당시 ctx의 회차에 저장한다.
      // 다음 게임 시작 시에는 기본값(true)으로 최신 운영 회차를 다시 동기화한다.
      const readiness = checkGameStartReadiness(ctx, normalizeRecordMode(rowWithoutId.game_mode), false);
      if (!readiness.ready) throw new Error(readiness.message || START_SETUP_REQUIRED_CLEAN);
      try {
        flushQueuedRecords(ctx);
      } catch {
        // 누락 기록 자동 반영 실패는 새 기록 저장 흐름을 막지 않는다.
      }
      const written = writeOneDriveJsonRecord(ctx, row);
      writeOperationalLog(ctx, {
        action: "record_save_success",
        targetPath: written.filePath,
        recordId: row.record_id,
        result: "success",
        details: { gameMode: row.game_mode, size: written.size, hash: written.hash }
      });
      try {
        flushQueuedRecords(ctx);
      } catch {
        // 다음 관리자 모드 또는 다음 저장 시 다시 시도한다.
      }
      return row;
    } catch (error) {
      writeOperationalLog(ctx, {
        level: "error",
        action: "record_save_failed",
        recordId: row.record_id,
        result: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        details: { gameMode: row.game_mode }
      });
      writeLocalQueue(ctx, row);
      throw error;
    }
  }

  try {
    return await withFileLock(ctx.paths.recordsFile, () => {
      const records = readCsv<RecordRow>(ctx.paths.recordsFile, RECORD_HEADERS, false);
      if (stableRecordId) {
        const existing = records.find((record) => record.record_id === stableRecordId);
        if (existing) return existing;
      }
      const maxId = records.reduce((max, record) => Math.max(max, Number(record.record_id) || 0), 0);
      const row: RecordRow = { record_id: stableRecordId ?? String(maxId + 1), ...rowWithoutId };
      writeCsvAtomic(ctx.paths.recordsFile, [...records, row], RECORD_HEADERS);
      return row;
    });
  } catch (error) {
    writeRecovery(ctx, rowWithoutId);
    throw error;
  }
}

function writeRecovery(ctx: RuntimeContext, row: Omit<RecordRow, "record_id">): void {
  ensureDir(ctx.paths.recoveryDir);
  const filePath = path.join(ctx.paths.recoveryDir, `record_recovery_${timestampForFile()}.csv`);
  writeCsvAtomic(filePath, [{ record_id: "recovery", ...row }], RECORD_HEADERS);
}

function backupRecords(ctx: RuntimeContext): string {
  ensureDir(ctx.paths.backupsDir);
  const backupPath = path.join(ctx.paths.backupsDir, `records_${timestampForFile()}.csv`);
  try {
    fs.copyFileSync(ctx.paths.recordsFile, backupPath);
    return backupPath;
  } catch {
    throw new Error("백업 파일 생성에 실패했습니다. 작업을 중단합니다.");
  }
}

export async function updateRecord(
  ctx: RuntimeContext,
  recordId: string,
  patch: Partial<RecordRow>,
  adminName: string
): Promise<RecordRow> {
  if (usesOneDriveJson(ctx)) {
    const before = readRecords(ctx).find((record) => record.record_id === recordId);
    if (!before) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
    const replacementId = `ADMIN_EDIT_${safeFilePart(recordId)}_${timestampForFile()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;
    const after = recalculateRecord({
      ...before,
      ...patch,
      record_id: replacementId,
      original_record_id: recordId,
      is_admin_edited: "true",
      memo: [before.memo, `관리자 수정 원본: ${recordId}`].filter(Boolean).join(" / ")
    });
    writeAdminAction(ctx, {
      action_id: createAdminActionId("edit", recordId),
      action_type: "edit",
      target_record_id: recordId,
      created_at: nowIso(),
      admin_name: adminName || "admin",
      admin_note: "원본 기록은 보존되고, 수정된 기록이 리더보드에 새로 표시됩니다.",
      day_no: practiceSessionMode ? undefined : ctx.config.dayNo,
      round_no: practiceSessionMode ? undefined : ctx.config.roundNo,
      game_mode: before.game_mode === "ai_challenge" ? "ai_challenge" : "normal",
      replacement_record: after
    });
    await appendAudit(ctx, {
      action_type: "edit_action",
      target_record_id: recordId,
      before_value: JSON.stringify(before),
      after_value: JSON.stringify(after),
      admin_name: adminName || "admin"
    });
    return after;
  }
  return withFileLock(ctx.paths.recordsFile, async () => {
    backupRecords(ctx);
    const records = readCsv<RecordRow>(ctx.paths.recordsFile, RECORD_HEADERS, false);
    const index = records.findIndex((record) => record.record_id === recordId);
    if (index < 0) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
    const before = records[index];
    const after = recalculateRecord({ ...before, ...patch });
    records[index] = after;
    writeCsvAtomic(ctx.paths.recordsFile, records, RECORD_HEADERS);
    await appendAudit(ctx, {
      action_type: "update",
      target_record_id: recordId,
      before_value: JSON.stringify(before),
      after_value: JSON.stringify(after),
      admin_name: adminName || "admin"
    });
    return after;
  });
}

export async function deleteRecord(ctx: RuntimeContext, recordId: string, adminName: string): Promise<void> {
  if (usesOneDriveJson(ctx)) {
    const target = readRecords(ctx).find((record) => record.record_id === recordId);
    if (!target) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
    writeAdminAction(ctx, {
      action_id: createAdminActionId("hide", recordId),
      action_type: "hide",
      target_record_id: recordId,
      created_at: nowIso(),
      admin_name: adminName || "admin",
      admin_note: "원본 기록은 삭제되지 않고 리더보드에서만 숨겨집니다.",
      day_no: practiceSessionMode ? undefined : ctx.config.dayNo,
      round_no: practiceSessionMode ? undefined : ctx.config.roundNo,
      game_mode: target.game_mode === "ai_challenge" ? "ai_challenge" : "normal"
    });
    await appendAudit(ctx, {
      action_type: "hide_action",
      target_record_id: recordId,
      before_value: JSON.stringify(target),
      after_value: "hidden_by_admin_action",
      admin_name: adminName || "admin"
    });
    return;
  }
  return withFileLock(ctx.paths.recordsFile, async () => {
    backupRecords(ctx);
    const records = readCsv<RecordRow>(ctx.paths.recordsFile, RECORD_HEADERS, false);
    const target = records.find((record) => record.record_id === recordId);
    if (!target) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
    writeCsvAtomic(
      ctx.paths.recordsFile,
      records.filter((record) => record.record_id !== recordId),
      RECORD_HEADERS
    );
    await appendAudit(ctx, {
      action_type: "delete",
      target_record_id: recordId,
      before_value: JSON.stringify(target),
      after_value: "",
      admin_name: adminName || "admin"
    });
  });
}

export async function clearRecords(
  ctx: RuntimeContext,
  adminName: string,
  gameMode?: "normal" | "ai_challenge"
): Promise<void> {
  if (usesOneDriveJson(ctx)) {
    const targetMode = normalizeRecordMode(gameMode);
    assertCsvBackupReady(ctx, [targetMode]);
    writeAdminAction(ctx, {
      action_id: createAdminActionId("reset_session", targetMode),
      action_type: "reset_session",
      created_at: nowIso(),
      admin_name: adminName || "admin",
      admin_note: "현재 회차의 원본 기록은 삭제되지 않고 리더보드 표시에서만 숨겨집니다.",
      day_no: practiceSessionMode ? undefined : ctx.config.dayNo,
      round_no: practiceSessionMode ? undefined : ctx.config.roundNo,
      game_mode: targetMode
    });
    await appendAudit(ctx, {
      action_type: "reset_session_action",
      target_record_id: targetMode,
      before_value: JSON.stringify({ day_no: ctx.config.dayNo, round_no: ctx.config.roundNo }),
      after_value: "hidden_by_reset_session_action",
      admin_name: adminName || "admin"
    });
    return;
  }
  return withFileLock(ctx.paths.recordsFile, async () => {
    const before = readCsv<RecordRow>(ctx.paths.recordsFile, RECORD_HEADERS, false);
    const remaining = gameMode
      ? before.filter((record) => (record.game_mode || "normal") !== gameMode)
      : [];
    const removed = gameMode
      ? before.filter((record) => (record.game_mode || "normal") === gameMode)
      : before;
    backupRecords(ctx);
    writeCsvAtomic(ctx.paths.recordsFile, remaining, RECORD_HEADERS);
    await appendAudit(ctx, {
      action_type: "clear",
      target_record_id: gameMode || "all",
      before_value: JSON.stringify({ count: removed.length, game_mode: gameMode || "all" }),
      after_value: JSON.stringify({ remaining: remaining.length }),
      admin_name: adminName || "admin"
    });
  });
}

export function recalculateRecord(record: RecordRow): RecordRow {
  const phoneError = validatePhoneParts(record.phone_part1, record.phone_part2, record.phone_part3);
  if (phoneError) throw new Error(phoneError);
  const phoneFull = buildPhoneFull(record.phone_part1, record.phone_part2, record.phone_part3);
  const birthdate = formatBirthdate(record.birth_year, record.birth_month, record.birth_day);

  const stage1 = Number(record.stage1_time_ms);
  const stage2 = Number(record.stage2_time_ms);
  const stage3 = Number(record.stage3_time_ms);
  if (![stage1, stage2, stage3].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("시간 기록은 숫자만 입력할 수 있습니다.");
  }

  const counts = [record.stage1_text, record.stage2_text, record.stage3_text].map((text) =>
    countTypeableChars(text)
  );
  const totalChars = counts.reduce((sum, count) => sum + count, 0);
  const typingUnits = [record.stage1_text, record.stage2_text, record.stage3_text].map((text) =>
    countConvertedTypingUnits(text)
  );
  const totalTypingUnits = typingUnits.reduce((sum, count) => sum + count, 0);
  const totalTime = stage1 + stage2 + stage3;

  return {
    ...record,
    phone_full: phoneFull,
    phone_masked: maskPhone(phoneFull),
    birth_month: record.birth_month.padStart(2, "0"),
    birth_day: record.birth_day.padStart(2, "0"),
    birthdate,
    birthdate_masked: maskBirthdate(birthdate),
    stage1_char_count: String(counts[0]),
    stage2_char_count: String(counts[1]),
    stage3_char_count: String(counts[2]),
    total_char_count: String(totalChars),
    stage1_cumulative_ms: String(Math.round(stage1)),
    stage2_cumulative_ms: String(Math.round(stage1 + stage2)),
    total_time_ms: String(Math.round(totalTime)),
    display_stage1_sec: formatMs(stage1),
    display_stage2_sec: formatMs(stage2),
    display_stage3_sec: formatMs(stage3),
    display_total_sec: formatMs(totalTime),
    final_cpm: String(calculateFinalCpm(totalTypingUnits, totalTime))
  };
}

async function appendAudit(
  ctx: RuntimeContext,
  input: Omit<AuditRow, "audit_id" | "created_at">
): Promise<void> {
  await withFileLock(ctx.paths.auditFile, () => {
    const rows = readCsv<AuditRow>(ctx.paths.auditFile, AUDIT_HEADERS, false);
    const maxId = rows.reduce((max, row) => Math.max(max, Number(row.audit_id) || 0), 0);
    rows.push({ audit_id: String(maxId + 1), created_at: nowIso(), ...input });
    writeCsvAtomic(ctx.paths.auditFile, rows, AUDIT_HEADERS);
  });
}

export async function addStageText(
  ctx: RuntimeContext,
  stageNumber: string,
  text: string,
  gameMode = "normal"
): Promise<StageText> {
  if (practiceSessionMode) throw new Error(PRACTICE_STAGE_TEXT_READONLY);
  return withFileLock(ctx.paths.stageTextsFile, () => {
    const normalized = text.trim();
    const normalizedMode = normalizeStageTextMode(gameMode);
    if (!stageNumber) throw new Error("스테이지를 선택해 주세요.");
    if (!normalized) throw new Error(text.length === 0 ? "문구를 입력해 주세요." : "공백만으로는 문구를 등록할 수 없습니다.");
    if (!["1", "2", "3"].includes(stageNumber)) throw new Error("스테이지를 선택해 주세요.");
    const rows = readCsv<StageText>(ctx.paths.stageTextsFile, STAGE_TEXT_HEADERS, false).map(normalizeStageTextRow);
    if (
      rows.some(
        (row) =>
          row.stage_number === stageNumber &&
          normalizeStageTextMode(row.game_mode) === normalizedMode &&
          row.text === normalized
      )
    ) {
      throw new Error("같은 스테이지에 이미 등록된 문구입니다.");
    }
    const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
    const createdAt = nowIso();
    const row: StageText = {
      id: String(maxId + 1),
      game_mode: normalizedMode,
      stage_number: stageNumber,
      text: normalized,
      is_active: "true",
      created_at: createdAt,
      updated_at: createdAt
    };
    writeCsvAtomic(ctx.paths.stageTextsFile, [...rows, row], STAGE_TEXT_HEADERS);
    markStageTextsDirty(ctx);
    return row;
  });
}

export async function updateStageText(
  ctx: RuntimeContext,
  id: string,
  patch: Partial<StageText>
): Promise<StageText> {
  if (practiceSessionMode) throw new Error(PRACTICE_STAGE_TEXT_READONLY);
  return withFileLock(ctx.paths.stageTextsFile, () => {
    const rows = readCsv<StageText>(ctx.paths.stageTextsFile, STAGE_TEXT_HEADERS, false).map(normalizeStageTextRow);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    const next = { ...rows[index], ...patch, updated_at: nowIso() };
    next.game_mode = normalizeStageTextMode(next.game_mode);
    next.text = next.text.trim();
    if (!["1", "2", "3"].includes(next.stage_number)) throw new Error("스테이지를 선택해 주세요.");
    if (!next.text) throw new Error("공백만으로는 문구를 등록할 수 없습니다.");
    if (
      rows.some(
        (row) =>
          row.id !== id &&
          row.stage_number === next.stage_number &&
          normalizeStageTextMode(row.game_mode) === normalizeStageTextMode(next.game_mode) &&
          row.text === next.text
      )
    ) {
      throw new Error("같은 스테이지에 이미 등록된 문구입니다.");
    }
    const candidate = [...rows];
    candidate[index] = next;
    assertStageHasActiveText(candidate, rows[index]);
    writeCsvAtomic(ctx.paths.stageTextsFile, candidate, STAGE_TEXT_HEADERS);
    markStageTextsDirty(ctx);
    return next;
  });
}

export async function softDeleteStageText(ctx: RuntimeContext, id: string): Promise<StageText> {
  return updateStageText(ctx, id, { is_active: "false" });
}

export async function hardDeleteStageText(ctx: RuntimeContext, id: string): Promise<void> {
  if (practiceSessionMode) throw new Error(PRACTICE_STAGE_TEXT_READONLY);
  return withFileLock(ctx.paths.stageTextsFile, () => {
    const rows = readCsv<StageText>(ctx.paths.stageTextsFile, STAGE_TEXT_HEADERS, false).map(normalizeStageTextRow);
    const target = rows.find((row) => row.id === id);
    if (!target) throw new Error("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    const next = rows.filter((row) => row.id !== id);
    writeCsvAtomic(ctx.paths.stageTextsFile, next, STAGE_TEXT_HEADERS);
    markStageTextsDirty(ctx);
  });
}

function assertStageHasActiveText(rows: StageText[], changed?: StageText): void {
  if (!changed) return;
  const changedMode = normalizeStageTextMode(changed.game_mode);
  const activeCount = rows.filter(
    (row) =>
      row.stage_number === changed.stage_number &&
      normalizeStageTextMode(row.game_mode) === changedMode &&
      row.is_active === "true"
  ).length;
  if (activeCount < 1) {
    throw new Error("각 스테이지에는 최소 1개 이상의 활성 문구가 필요합니다.");
  }
}

export function listBackups(ctx: RuntimeContext): string[] {
  ensureDir(ctx.paths.backupsDir);
  return fs
    .readdirSync(ctx.paths.backupsDir)
    .filter((name) => /^records_\d{8}_\d{6}\.csv$/.test(name))
    .sort()
    .reverse();
}

export async function restoreBackup(ctx: RuntimeContext, backupName: string, adminName: string): Promise<void> {
  const safeName = path.basename(backupName);
  const backupPath = path.join(ctx.paths.backupsDir, safeName);
  if (!fs.existsSync(backupPath)) throw new Error("백업 파일 복원에 실패했습니다.");
  return withFileLock(ctx.paths.recordsFile, async () => {
    backupRecords(ctx);
    fs.copyFileSync(backupPath, ctx.paths.recordsFile);
    await appendAudit(ctx, {
      action_type: "restore",
      target_record_id: "all",
      before_value: "",
      after_value: safeName,
      admin_name: adminName || "admin"
    });
  });
}

export function exportRecords(
  ctx: RuntimeContext,
  rows: RecordRow[],
  scope: "all" | "filtered" | "leaderboard",
  gameMode?: "normal" | "ai_challenge"
): string {
  const refreshedMode = normalizeRecordMode(
    gameMode ?? (rows.some((row) => row.game_mode === "ai_challenge") ? "ai_challenge" : "normal")
  );
  if (usesOneDriveJson(ctx) && ctx.config.exportPath) {
    const latestRows = currentBackupTargetRecords(ctx, refreshedMode);
    const enrichedById = new Map(rows.map((row) => [row.record_id, row]));
    rows = latestRows.map((row) => enrichedById.get(row.record_id) ?? row);
  }
  if (rows.length === 0) throw new Error("내보낼 기록이 없습니다.");
  const isOneDrive = usesOneDriveJson(ctx) && ctx.config.exportPath;
  const exportDir = isOneDrive ? ctx.config.exportPath : ctx.paths.exportsDir;
  ensureDir(exportDir);
  const exportMode = gameMode ?? (rows.some((row) => row.game_mode === "ai_challenge") ? "ai_challenge" : "normal");
  const hasAi = exportMode === "ai_challenge";
  const modeLabel = hasAi ? "AI타자왕" : "일잘러타자왕";
  const sessionLabel = practiceSessionMode
    ? PRACTICE_SESSION_DIR_NAME
    : `${ctx.config.dayNo}일차_${ctx.config.roundNo}회차`;
  const fileName = isOneDrive
    ? `${modeLabel}_${sessionLabel}_리더보드_${uniqueOperationStamp(ctx)}.csv`
    : `typingking_export_${uniqueOperationStamp(ctx)}.csv`;
  const filePath = path.join(exportDir, fileName);
  const exportRows = withExportRanks(rows, normalizeRecordMode(exportMode));
  writeCsvAtomic(filePath, exportRows, EXPORT_RECORD_HEADERS);
  writeOperationalLog(ctx, {
    action: "csv_export",
    targetPath: filePath,
    result: "success",
    details: { scope, gameMode: exportMode, count: exportRows.length }
  });
  return path.basename(filePath);
}
