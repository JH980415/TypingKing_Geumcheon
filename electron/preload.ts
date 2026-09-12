import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AppConfig, DrawStageTextsInput, RecordListRequest, RecordRow, SaveRecordInput, StageText } from "../shared/types";

const ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL =
  "records:requestActiveAttemptCheckpoint";
const ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL =
  "records:activeAttemptCheckpointReady";

let bootstrapContextCaptured=false;
let runtimeContextEpoch:string|undefined;
async function getBootstrap() {
  const result=await ipcRenderer.invoke("app:getBootstrap");
  if(result?.ok===true&&result.data) {
    if(!bootstrapContextCaptured) {
      bootstrapContextCaptured=true;
      runtimeContextEpoch=typeof result.data.runtimeContextEpoch==="string"?result.data.runtimeContextEpoch:undefined;
    }
    return {...result,data:{...result.data,runtimeContextEpoch}};
  }
  return result;
}

contextBridge.exposeInMainWorld("typingKing", {
  getBootstrap,
  getDeploymentStatus: () => ipcRenderer.invoke("deployment:status"),
  chooseDeploymentProfile: () => ipcRenderer.invoke("deployment:choose"),
  cancelDeploymentProfile: () => ipcRenderer.invoke("deployment:cancel"),
  applyDeploymentProfile: () => ipcRenderer.invoke("deployment:apply"),
  setDeploymentSession: (dayNo:number, roundNo:number) => ipcRenderer.invoke("deployment:setSession",dayNo,roundNo),
  validateAdmin: (password: string, adminName?: string) =>
    ipcRenderer.invoke("admin:validate", password, adminName),
  validateReviewStorage: () => ipcRenderer.invoke("review:validateStorage"),
  listStageTexts: () => ipcRenderer.invoke("stage:list"),
  drawStageTexts: (input: DrawStageTextsInput) => ipcRenderer.invoke("stage:draw", input),
  getStageReadiness: (gameMode?: string) => ipcRenderer.invoke("stage:readiness", gameMode),
  addStageText: (stageNumber: string, text: string, gameMode?: string) =>
    ipcRenderer.invoke("stage:add", stageNumber, text, gameMode),
  updateStageText: (id: string, patch: Partial<StageText>) =>
    ipcRenderer.invoke("stage:update", id, patch),
  softDeleteStageText: (id: string) => ipcRenderer.invoke("stage:softDelete", id),
  hardDeleteStageText: (id: string) => ipcRenderer.invoke("stage:hardDelete", id),
  publishStageTextsToOneDrive: () => ipcRenderer.invoke("stage:publishShared"),
  onActiveAttemptCheckpointRequested: (handler: (requestId: string) => Promise<void>) => {
    const listener = (_event: IpcRendererEvent, requestId: unknown) => {
      if (
        typeof requestId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
      ) {
        return;
      }
      void Promise.resolve()
        .then(() => handler(requestId))
        .then(
          () => ipcRenderer.send(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL, requestId, true),
          () => ipcRenderer.send(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL, requestId, false)
        );
    };
    ipcRenderer.on(ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL, listener);
    return () => ipcRenderer.removeListener(ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL, listener);
  },
  checkpointActiveAttempt: (input: SaveRecordInput, closeRequestId?: string) =>
    ipcRenderer.invoke("records:checkpointActiveAttempt", input, closeRequestId, runtimeContextEpoch),
  saveRecord: (input: SaveRecordInput) => ipcRenderer.invoke("records:save", input, runtimeContextEpoch),
  checkGameStartReadiness: (gameMode: "normal" | "ai_challenge") =>
    ipcRenderer.invoke("records:checkStartReady", gameMode),
  listRecords: (request?: RecordListRequest) => request === undefined
    ? ipcRenderer.invoke("records:list") : ipcRenderer.invoke("records:list", request),
  updateRecord: (recordId: string, patch: Partial<RecordRow>, adminName: string) =>
    ipcRenderer.invoke("records:update", recordId, patch, adminName, runtimeContextEpoch),
  deleteRecord: (recordId: string, adminName: string) =>
    ipcRenderer.invoke("records:delete", recordId, adminName, runtimeContextEpoch),
  clearRecords: (adminName: string) => ipcRenderer.invoke("records:clear", adminName, runtimeContextEpoch),
  exportRecords: (rows: RecordRow[], scope: "all" | "filtered" | "leaderboard") =>
    ipcRenderer.invoke("records:export", rows, scope),
  exportCurrentSessionBackup: () => ipcRenderer.invoke("records:exportSessionBackup"),
  getLeaderboardSyncStatus: () => ipcRenderer.invoke("records:syncStatus"),
  getCsvBackupStatus: () => ipcRenderer.invoke("records:backupStatus"),
  getQueuedRecordStatus: () => ipcRenderer.invoke("queue:status"),
  flushQueuedRecords: () => ipcRenderer.invoke("queue:flush"),
  listBackups: () => ipcRenderer.invoke("backups:list"),
  restoreBackup: (backupName: string, adminName: string) =>
    ipcRenderer.invoke("backups:restore", backupName, adminName),
  getOneDriveSettings: () => ipcRenderer.invoke("sync:getSettings"),
  updateOneDriveSettings: (
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
  ) => ipcRenderer.invoke("sync:updateSettings", patch),
  validateOneDriveSetup: () => ipcRenderer.invoke("sync:validateSetup"),
  pokeOneDriveSync: (reason?: string) => ipcRenderer.invoke("sync:poke", reason),
  cleanupLegacyOneDriveArtifacts: () => ipcRenderer.invoke("sync:cleanupLegacyArtifacts"),
  chooseOneDriveRoot: () => ipcRenderer.invoke("sync:chooseRoot"),
  openSessionFolder: () => ipcRenderer.invoke("sync:openSessionFolder")
});
