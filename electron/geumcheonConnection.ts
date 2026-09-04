import path from "node:path";

import type { DeviceProfile } from "../shared/events/types";
import type {
  GameStartReadiness,
  PcRole,
  RecordRow,
  ReviewRuntimeContext,
  ReviewStorageValidation,
  SaveRecordInput
} from "../shared/types";
import { createActiveAttemptStore, type ActiveAttemptEncryption } from "./activeAttemptStore";
import { createGeumcheonRecordRuntime } from "./geumcheonRecordRuntime";
import { RendererCheckpointFence } from "./rendererCheckpointHandshake";
import {
  createReviewAttemptIdentity,
  createReviewLocalRuntime,
  reviewAttemptIdentityPolicy,
  type ReviewLocalRuntime,
  type ReviewSession
} from "./review/reviewLocalRuntime";

type ConnectionFactoryOptions<TProduction, TReview> = {
  reviewContext?: ReviewRuntimeContext;
  deviceProfile?: DeviceProfile;
  createProduction(deviceProfile: DeviceProfile): Promise<TProduction>;
  createReview(reviewContext: ReviewRuntimeContext): Promise<TReview>;
};

export async function initializeGeumcheonConnection<TProduction, TReview>(
  options: ConnectionFactoryOptions<TProduction, TReview>
): Promise<TProduction | TReview> {
  if (options.reviewContext) return options.createReview(options.reviewContext);
  if (!options.deviceProfile) throw new Error("GEUMCHEON_DEVICE_PROFILE_REQUIRED");
  return options.createProduction(options.deviceProfile);
}

export const REVIEW_EXTERNAL_STORAGE_IPC_CHANNELS = [
  "stage:publishShared",
  "sync:getSettings",
  "sync:updateSettings",
  "sync:validateSetup",
  "sync:poke",
  "sync:cleanupLegacyArtifacts",
  "sync:chooseRoot",
  "sync:openSessionFolder"
] as const;

export type ReviewExternalStorageIpcChannel = typeof REVIEW_EXTERNAL_STORAGE_IPC_CHANNELS[number];

export function assertReviewExternalStorageIpcAllowed(
  reviewContext: ReviewRuntimeContext | undefined,
  _channel: ReviewExternalStorageIpcChannel
): void {
  if (reviewContext) throw new Error("REVIEW_EXTERNAL_STORAGE_DISABLED");
}

export function assertPlayerRecordSaveAllowed(role: PcRole): void {
  if (role !== "player") throw new Error("RECORD_SAVE_PLAYER_ONLY");
}

export async function validateReviewStorage(options: {
  reviewContext: ReviewRuntimeContext;
  runtime: Pick<ReviewLocalRuntime, "validateStorage">;
  requireAdmin(): void;
}): Promise<ReviewStorageValidation> {
  options.requireAdmin();
  const result = await options.runtime.validateStorage().then(() => "normal" as const, () => "error" as const);
  return {
    storage: "local",
    environment: "review",
    role: options.reviewContext.role,
    session: options.reviewContext.sessionKind,
    result
  };
}

export type GeumcheonRecordListConnection = {
  source: "production" | "review";
  runtime: {
    loadRecords(): Promise<{ rows: RecordRow[] }>;
  };
};

export async function listGeumcheonRecords(options: {
  connection: GeumcheonRecordListConnection | null;
  role: "player" | "leaderboard";
  readLegacy(): Promise<RecordRow[]> | RecordRow[];
}): Promise<RecordRow[]> {
  if (options.connection?.source === "review" || (options.connection && options.role === "leaderboard")) {
    return (await options.connection.runtime.loadRecords()).rows;
  }
  return options.readLegacy();
}

export type ReviewGeumcheonConnection = {
  source: "review";
  reviewContext: ReviewRuntimeContext;
  localRuntime: ReviewLocalRuntime;
  checkpointFence: RendererCheckpointFence;
  checkReadiness(): Promise<GameStartReadiness>;
  flush(): Promise<{ attempted: number; sent: number; blocked: number; deferred: number; authRequired: false }>;
  runtime: {
    checkpoint(input: SaveRecordInput): ReturnType<ReturnType<typeof createGeumcheonRecordRuntime>["checkpoint"]>;
    save(input: SaveRecordInput): Promise<RecordRow>;
    recover(): Promise<RecordRow | null>;
    queueStatus(): Promise<{ pending: number; blocked: number }>;
    loadRecords(): Promise<{ rows: RecordRow[] }>;
    edit(recordId: string, replacement: RecordRow, adminName: string): Promise<RecordRow>;
    hide(recordId: string, hidden: boolean, adminName: string): Promise<void>;
    resetSession(adminName: string): Promise<void>;
  };
};

function reviewSession(context: ReviewRuntimeContext): ReviewSession {
  return context.sessionKind === "practice"
    ? { kind: "practice", sessionId: "review-practice" }
    : { kind: "official", sessionId: "review-official-1", dayNo: 1, roundNo: 1 };
}

export function createReviewGeumcheonConnection(options: {
  reviewContext: ReviewRuntimeContext;
  runtimeRoot: string;
  encryption: ActiveAttemptEncryption;
  persistLocal(input: SaveRecordInput, recordId: string): Promise<RecordRow>;
  now?: () => string;
}): ReviewGeumcheonConnection {
  const localRuntime = createReviewLocalRuntime({
    rootDir: options.runtimeRoot,
    role: options.reviewContext.role,
    session: reviewSession(options.reviewContext),
    reviewContext: options.reviewContext
  });
  const store = createActiveAttemptStore({
    checkpointPath: path.join(options.runtimeRoot, ".review-state", `active-attempt-${options.reviewContext.sessionKind}.bin`),
    encryption: options.encryption,
    eventProfileId: options.reviewContext.profileId,
    identityPolicy: reviewAttemptIdentityPolicy
  });
  const records = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: options.reviewContext.sessionKind === "practice" ? "practice" : "ai",
    deviceId: options.reviewContext.deviceId,
    store,
    createAttemptIdentity: createReviewAttemptIdentity,
    now: options.now ?? (() => new Date().toISOString()),
    persistLocal: async (input, identity) => {
      const row = await options.persistLocal(input, identity.recordId);
      return localRuntime.save(row);
    },
    enqueue: async () => undefined,
    identityPolicy: reviewAttemptIdentityPolicy
  });

  return {
    source: "review",
    reviewContext: options.reviewContext,
    localRuntime,
    checkpointFence: new RendererCheckpointFence(),
    checkReadiness: async () => localRuntime.list().then(
      () => ({ ready: true }),
      () => ({ ready: false, message: "로컬 검토 저장소를 확인할 수 없습니다." })
    ),
    flush: async () => ({ attempted: 0, sent: 0, blocked: 0, deferred: 0, authRequired: false }),
    runtime: {
      checkpoint: (input) => records.checkpoint(input),
      save: (input) => records.save(input),
      recover: () => records.recover(),
      queueStatus: async () => ({ pending: 0, blocked: 0 }),
      loadRecords: async () => ({ rows: await localRuntime.list() }),
      edit: (recordId, replacement, _adminName) => localRuntime.edit(recordId, replacement),
      hide: async (recordId, hidden, _adminName) => {
        if (!hidden) throw new Error("REVIEW_UNHIDE_UNSUPPORTED");
        await localRuntime.hide(recordId);
      },
      resetSession: async (_adminName) => localRuntime.reset()
    }
  };
}
