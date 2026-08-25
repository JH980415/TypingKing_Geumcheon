import type { DeviceProfile, EventProfile, EventVariantPolicy } from "../events/types";

export type AppMode = "game" | "leaderboard";
export type { DeviceProfile, EventProfile, EventProfileId, EventVariantPolicy, SessionKind } from "../events/types";
export type AppVariant =
  | "typing"
  | "typing-leaderboard"
  | "ai"
  | "ai-leaderboard"
  | "practice"
  | "practice-leaderboard";
export type SyncMode = "local" | "onedrive_manual";
export type PcRole = "player" | "leaderboard";

export type ThemeConfig = {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  correctColor: string;
  wrongColor: string;
  cyanColor?: string;
  orangeColor?: string;
  successColor?: string;
};

export type AiSpeedRange = {
  min: number;
  max: number;
};

export type AiChallengeConfig = {
  enabled: boolean;
  stageSpeedRanges: {
    stage1: AiSpeedRange;
    stage2: AiSpeedRange;
    stage3: AiSpeedRange;
  };
  countdownSeconds: number;
  aiEnterDelayMs: number;
  aiSpeedChangeIntervalMs: number;
};

export type AppConfig = {
  eventName: string;
  stageCount: number;
  adminPassword: string;
  leaderboardRefreshSeconds: number;
  allowRetry: boolean;
  leaderboardMode: "best_record_only" | "all_records";
  requirePhoneFull: boolean;
  requireBirthdate: boolean;
  requirePrivacyConsent: boolean;
  blockPaste: boolean;
  showAccuracy: boolean;
  showCpm: boolean;
  birthYearStart: number;
  birthYearEndMode: "currentYear" | "fixed";
  birthYearEnd?: number;
  privacyConsentText: string;
  theme: ThemeConfig;
  aiChallenge: AiChallengeConfig;
  syncMode: SyncMode;
  pcRole: PcRole;
  pcId: string;
  oneDriveRoot: string;
  recordBaseFolderName: string;
  dayNo: number;
  roundNo: number;
  isPracticeSession: boolean;
  sessionName: string;
  sessionDataRoot: string;
  typingIncomingPath: string;
  aiIncomingPath: string;
  exportPath: string;
  logsPath: string;
  setupComplete: boolean;
  setupValidatedAt: string;
  syncRetryMs: number;
  leaderboardRefreshMs: number;
};

export type StageText = {
  id: string;
  catalog_version?: string;
  game_mode: string;
  stage_number: string;
  text: string;
  is_active: string;
  created_at: string;
  updated_at: string;
};

export type DrawStageTextsInput = {
  sessionKind: "official" | "practice";
  gameMode: "ai_challenge";
};

export type StageTextSelection = {
  id: string;
  catalogVersion: string;
  stageNumber: 1 | 2 | 3;
  text: string;
};

export type DrawStageTextsResult = {
  catalogVersion: string;
  selections: readonly [StageTextSelection, StageTextSelection, StageTextSelection];
};

export type RecordRow = {
  record_id: string;
  created_at: string;
  completed_at: string;
  participant_name: string;
  phone_part1: string;
  phone_part2: string;
  phone_part3: string;
  phone_full: string;
  phone_masked: string;
  birth_year: string;
  birth_month: string;
  birth_day: string;
  birthdate: string;
  birthdate_masked: string;
  privacy_agreed: string;
  privacy_agreed_at: string;
  stage1_text: string;
  stage2_text: string;
  stage3_text: string;
  stage1_char_count: string;
  stage2_char_count: string;
  stage3_char_count: string;
  total_char_count: string;
  stage1_time_ms: string;
  stage2_time_ms: string;
  stage3_time_ms: string;
  stage1_cumulative_ms: string;
  stage2_cumulative_ms: string;
  total_time_ms: string;
  display_stage1_sec: string;
  display_stage2_sec: string;
  display_stage3_sec: string;
  display_total_sec: string;
  final_cpm: string;
  final_accuracy: string;
  app_version: string;
  is_test: string;
  is_debug: string;
  debug_mode_type: string;
  memo: string;
  game_mode: string;
  ai_enabled: string;
  ai_challenge_status: string;
  ai_failed_stage: string;
  ai_stage1_cpm: string;
  ai_stage2_cpm: string;
  ai_stage3_cpm: string;
  ai_stage1_time_ms: string;
  ai_stage2_time_ms: string;
  ai_stage3_time_ms: string;
  ai_total_time_ms: string;
  stage1_vs_ai_result: string;
  stage2_vs_ai_result: string;
  stage3_vs_ai_result: string;
  final_vs_ai_result: string;
  stage1_time_diff_ms: string;
  stage2_time_diff_ms: string;
  stage3_time_diff_ms: string;
  final_time_diff_ms: string;
  participant_result_time_ms: string;
  ai_result_time_ms: string;
  participant_avg_cpm: string;
  ai_avg_cpm: string;
  challenge_result_label: string;
  participant_progress_percent: string;
  ai_progress_percent: string;
  duel_time_ms: string;
  result_stage: string;
  original_record_id: string;
  is_admin_edited: string;
};

export type SaveRecordInput = {
  participant_name: string;
  phone_part1: string;
  phone_part2: string;
  phone_part3: string;
  birth_year: string;
  birth_month: string;
  birth_day: string;
  privacy_agreed: boolean;
  privacy_agreed_at: string;
  stageTexts: [string, string, string];
  stageTimesMs: [number, number, number];
  game_mode?: "normal" | "ai_challenge";
  final_accuracy?: number;
  ai?: {
    status: "SUCCESS" | "FAILED";
    failedStage: string;
    stageCpms: [number | null, number | null, number | null];
    stageTimesMs: [number | null, number | null, number | null];
    stageResults: ["" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN"];
    finalResult: "" | "USER_WIN" | "AI_WIN";
    stageDiffsMs: [number | null, number | null, number | null];
    finalDiffMs: number | null;
    display?: {
      participantResultTimeMs: number | null;
      aiResultTimeMs: number | null;
      participantAvgCpm: number | null;
      aiAvgCpm: number | null;
      resultLabel: string;
      participantProgressPercent?: number | null;
      aiProgressPercent?: number | null;
      duelTimeMs?: number | null;
      resultStage?: number | null;
    };
  };
  is_test?: boolean;
  is_debug?: boolean;
  debug_mode_type?: "" | "normal_typing_debug" | "ai_challenge_debug";
  memo?: string;
  interruption?: {
    action: "home" | "retry";
    resultStage: number;
    participantProgressPercent: number;
    stageCharCounts: [number, number, number];
    totalTypingUnits: number;
  };
};

export type AuditRow = {
  audit_id: string;
  action_type: string;
  target_record_id: string;
  before_value: string;
  after_value: string;
  admin_name: string;
  created_at: string;
};

export type ApiResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  notices?: string[];
};

export type LeaderboardSyncStatus = {
  sessionName: string;
  dayNo: number;
  roundNo: number;
  lastReadAt: string;
  sourceFileCount: number;
  reflectedRecordCount: number;
  ignoredFileCount: number;
  status: "정상" | "기록 없음" | "주의" | "오류";
  error?: string;
};

export type GameStartReadiness = {
  ready: boolean;
  message?: string;
  targetPath?: string;
  reasons?: string[];
};

export type QueuedRecordFlushDetail = {
  sourceFileName?: string;
  fileName?: string;
  recordId?: string;
  gameMode?: string;
  targetPath?: string;
  error?: string;
};

export type QueuedRecordFlushResult = {
  attempted: number;
  sent: number;
  failed: number;
  targetPaths: string[];
  failures: QueuedRecordFlushDetail[];
};

export type OneDriveCleanupResult = {
  deletedFileCount: number;
  deletedBytes: number;
  failedFileCount: number;
  scannedDirectories: string[];
};

export type CsvBackupModeStatus = {
  mode: "normal" | "ai_challenge";
  gameMode?: "normal" | "ai_challenge";
  label?: string;
  recordCount: number;
  backedUpRecordCount?: number;
  latestBackupAt: string;
  latestCsvFileName: string;
  recordIdHash?: string;
  markerHash?: string;
  staleReason?: string;
  required: boolean;
  complete: boolean;
  backupComplete?: boolean;
  latestRecordCount?: number;
  stale?: boolean;
};

export type CsvBackupStatus = {
  sessionName: string;
  dayNo: number;
  roundNo: number;
  normal: CsvBackupModeStatus;
  ai: CsvBackupModeStatus;
  missingModes: Array<"normal" | "ai_challenge">;
  modes?: CsvBackupModeStatus[];
};

export type CsvBackupExportResult = {
  fileName: string;
  markerFileName: string;
  exportedRecordCount: number;
  recordCount?: number;
  exportDir?: string;
  recordIds: string[];
  recordIdHash: string;
  message: string;
};

export type BootstrapData = {
  config: AppConfig;
  assetBaseUrl: string;
  notices: string[];
  mode: AppMode;
  variant: AppVariant;
  eventProfile: EventProfile;
  variantPolicy: EventVariantPolicy;
  deviceProfile?: DeviceProfile;
};
