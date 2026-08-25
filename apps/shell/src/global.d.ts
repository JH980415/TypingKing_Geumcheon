import type {
  ApiResult,
  AppConfig,
  BootstrapData,
  CsvBackupExportResult,
  CsvBackupStatus,
  GameStartReadiness,
  LeaderboardSyncStatus,
  OneDriveCleanupResult,
  QueuedRecordFlushResult,
  RecordRow,
  SaveRecordInput,
  StageText
} from "../../../shared/types";

declare global {
  interface Window {
    typingKing: {
      getBootstrap(): Promise<ApiResult<BootstrapData>>;
      validateAdmin(password: string, adminName?: string): Promise<ApiResult<{ adminName: string }>>;
      listStageTexts(): Promise<ApiResult<StageText[]>>;
      getStageReadiness(gameMode?: string): Promise<ApiResult<string[]>>;
      addStageText(stageNumber: string, text: string, gameMode?: string): Promise<ApiResult<StageText>>;
      updateStageText(id: string, patch: Partial<StageText>): Promise<ApiResult<StageText>>;
      softDeleteStageText(id: string): Promise<ApiResult<StageText>>;
      hardDeleteStageText(id: string): Promise<ApiResult<void>>;
      publishStageTextsToOneDrive(): Promise<ApiResult<{ filePath: string; count: number; hash: string; updatedAt: string }>>;
      saveRecord(input: SaveRecordInput): Promise<ApiResult<RecordRow>>;
      checkGameStartReadiness(gameMode: "normal" | "ai_challenge"): Promise<ApiResult<GameStartReadiness>>;
      listRecords(): Promise<ApiResult<RecordRow[]>>;
      updateRecord(recordId: string, patch: Partial<RecordRow>, adminName: string): Promise<ApiResult<RecordRow>>;
      deleteRecord(recordId: string, adminName: string): Promise<ApiResult<void>>;
      clearRecords(adminName: string): Promise<ApiResult<void>>;
      exportRecords(rows: RecordRow[], scope: "all" | "filtered" | "leaderboard"): Promise<ApiResult<string>>;
      exportCurrentSessionBackup(): Promise<ApiResult<CsvBackupExportResult>>;
      getLeaderboardSyncStatus(): Promise<ApiResult<LeaderboardSyncStatus>>;
      getCsvBackupStatus(): Promise<ApiResult<CsvBackupStatus>>;
      getQueuedRecordStatus(): Promise<ApiResult<{ count: number }>>;
      flushQueuedRecords(): Promise<ApiResult<QueuedRecordFlushResult>>;
      listBackups(): Promise<ApiResult<string[]>>;
      restoreBackup(backupName: string, adminName: string): Promise<ApiResult<void>>;
      getOneDriveSettings(): Promise<ApiResult<AppConfig>>;
      updateOneDriveSettings(
        patch: Partial<
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
        >
      ): Promise<ApiResult<AppConfig>>;
      validateOneDriveSetup(): Promise<ApiResult<AppConfig>>;
      pokeOneDriveSync(reason?: string): Promise<ApiResult<{ ok: boolean; heartbeatPath: string }>>;
      cleanupLegacyOneDriveArtifacts(): Promise<ApiResult<OneDriveCleanupResult>>;
      chooseOneDriveRoot(): Promise<ApiResult<AppConfig>>;
      openSessionFolder(): Promise<ApiResult<string>>;
    };
  }
}

export {};
