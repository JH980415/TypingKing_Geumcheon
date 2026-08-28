import { randomUUID } from "node:crypto";
import path from "node:path";
import { createActiveAttemptStore } from "../activeAttemptStore";
import { createGeumcheonRecordRuntime, type ActiveAttemptCheckpoint } from "../geumcheonRecordRuntime";
import type { DeviceProfile, EventProfile, RecordRow, SaveRecordInput, SessionKind } from "../../shared/types";
import { createGeumcheonRecordId, type NasRecordEnvelopeV1, type NasSessionV1 } from "../../shared/nas/protocol";
import { NasAdminSession, type AdminActionBase } from "./adminSession";
import { NasApiClient, type FetchLike, type TimerAdapter } from "./apiClient";
import { NasCredentialStore, type SafeStorageAdapter } from "./credentialStore";
import { NasLeaderboardClient } from "./leaderboardClient";
import { EncryptedNasOutbox } from "./outbox";
import { NasRetryWorker, type RetryFlushResult } from "./retryWorker";

const EVENT_PROFILE_ID = "geumcheon-2026";
const NAS_EVENT_ID = "geumcheon-science-festival-2026";

export type GeumcheonLocalCallbacks = {
  persist(input: SaveRecordInput, recordId: string): Promise<RecordRow>;
  read(): Promise<RecordRow[]>;
  admin: {
    edit(recordId: string, replacement: RecordRow, adminName: string): Promise<void>;
    hide(recordId: string, hidden: boolean, adminName: string): Promise<void>;
    resetSession(session: NasSessionV1, adminName: string): Promise<void>;
  };
};

export type GeumcheonNasRuntimeOptions = {
  event: EventProfile;
  device: DeviceProfile;
  sessionKind: SessionKind;
  runtimeRoot: string;
  safeStorage: SafeStorageAdapter;
  fetch: FetchLike;
  local: GeumcheonLocalCallbacks;
  createRecordId?: () => string;
  createActionId?: () => string;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  timers?: TimerAdapter;
};

export type GeumcheonNasRuntime = {
  importToken(token: string): Promise<void>;
  checkReady(): ReturnType<NasApiClient["getReady"]>;
  checkpoint(input: SaveRecordInput): ReturnType<ReturnType<typeof createGeumcheonRecordRuntime>["checkpoint"]>;
  save(input: SaveRecordInput): Promise<RecordRow>;
  recover(): Promise<RecordRow | null>;
  flush(): Promise<RetryFlushResult>;
  queueStatus(): Promise<{ pending: number; blocked: number }>;
  loadRecords(): ReturnType<NasLeaderboardClient["load"]>;
  edit(recordId: string, replacement: RecordRow, adminName: string): Promise<unknown>;
  hide(recordId: string, hidden: boolean, adminName: string): Promise<unknown>;
  resetSession(adminName: string): Promise<unknown>;
};

export function createGeumcheonNasRuntime(options: GeumcheonNasRuntimeOptions): GeumcheonNasRuntime {
  validateOptions(options);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const session = sessionFor(options.device, options.sessionKind);
  const credentials = new NasCredentialStore({
    filePath: path.join(runtimeRoot, "nas", "device-token.bin"),
    safeStorage: options.safeStorage,
    eventId: options.event.nasEventId,
    deviceId: options.device.deviceId,
    apiBaseUrl: options.device.apiBaseUrl
  });
  const outbox = new EncryptedNasOutbox({ rootDir: path.join(runtimeRoot, "nas", "outbox"), safeStorage: options.safeStorage });
  const api = new NasApiClient({
    baseUrl: options.device.apiBaseUrl,
    deviceId: options.device.deviceId,
    getToken: () => credentials.getToken(),
    fetch: options.fetch,
    requestTimeoutMs: options.device.requestTimeoutMs,
    timers: options.timers,
  });
  const retry = new NasRetryWorker({
    outbox,
    transport: api,
    initialDelayMs: options.device.retry.initialDelayMs,
    maxDelayMs: options.device.retry.maxDelayMs,
    maxAttempts: 4,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))),
  });
  const leaderboard = new NasLeaderboardClient(api);
  const admin = new NasAdminSession(api);
  const activeStore = createActiveAttemptStore({
    checkpointPath: path.join(runtimeRoot, "nas", `active-attempt-${options.sessionKind}.bin`),
    encryption: options.safeStorage,
    eventProfileId: EVENT_PROFILE_ID,
  });
  const now = options.now ?? (() => new Date().toISOString());
  const createRecordId = options.createRecordId ?? (() => createGeumcheonRecordId(options.device.deviceId, randomUUID));
  const createActionId = options.createActionId ?? (() => `gsc26-action-${randomUUID()}`);
  const records = createGeumcheonRecordRuntime({
    eventProfileId: EVENT_PROFILE_ID,
    variant: options.sessionKind === "official" ? "ai" : "practice",
    store: {
      save: (checkpoint) => activeStore.save(checkpoint),
      read: async () => await activeStore.read() as ActiveAttemptCheckpoint | null,
      clear: () => activeStore.clear(),
    },
    createRecordId,
    now,
    persistLocal: options.local.persist,
    enqueue: (row) => outbox.enqueue(options.sessionKind, {
      schema_version: 1,
      event_id: NAS_EVENT_ID,
      session,
      row,
    } as unknown as NasRecordEnvelopeV1),
  });
  let lastKnownGood: Awaited<ReturnType<NasLeaderboardClient["load"]>> | undefined;

  function requireRole(role: "player" | "leaderboard"): void {
    if (options.device.role !== role) throw new Error("NAS_ROLE_FORBIDDEN");
  }

  function actionBase(adminName: string): AdminActionBase {
    requireRole("leaderboard");
    if (typeof adminName !== "string" || adminName.trim() === "") throw new Error("NAS_ADMIN_NAME_INVALID");
    return {
      schema_version: 1,
      event_id: NAS_EVENT_ID,
      action_id: createActionId(),
      created_at: now(),
      session,
      admin_name: adminName,
    };
  }

  return {
    importToken: (token) => credentials.importToken(token),
    checkReady: () => api.getReady(session, {
      eventId: NAS_EVENT_ID,
      role: options.device.role === "player" ? "writer" : "operator",
    }),
    checkpoint: async (input) => { requireRole("player"); return records.checkpoint(input); },
    save: async (input) => { requireRole("player"); return records.save(input); },
    recover: async () => { requireRole("player"); return records.recover(); },
    flush: async () => { requireRole("player"); return retry.flush(options.sessionKind); },
    queueStatus: async () => {
      const [pending, blocked] = await Promise.all([outbox.list(options.sessionKind), outbox.listBlocked(options.sessionKind)]);
      return { pending: pending.length, blocked: blocked.length };
    },
    loadRecords: async () => {
      requireRole("leaderboard");
      try {
        lastKnownGood = await leaderboard.load(session);
        return lastKnownGood;
      } catch (error) {
        if (lastKnownGood != null) return lastKnownGood;
        throw error;
      }
    },
    edit: (recordId, replacement, adminName) => {
      if (replacement.record_id !== recordId) return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_ID_MISMATCH"));
      const { record_id: _recordId, ...changes } = replacement;
      return admin.edit(actionBase(adminName), recordId, changes);
    },
    hide: (recordId, hidden, adminName) => admin.hide(actionBase(adminName), recordId, hidden),
    resetSession: (adminName) => admin.resetSession(actionBase(adminName)),
  };
}

function sessionFor(device: DeviceProfile, kind: SessionKind): NasSessionV1 {
  if (kind === "official") {
    return {
      kind,
      session_id: device.sessions.official.sessionId,
      day_no: device.sessions.official.dayNo,
      round_no: device.sessions.official.roundNo,
    };
  }
  return { kind, session_id: device.sessions.practice.sessionId };
}

function validateOptions(options: GeumcheonNasRuntimeOptions): void {
  if (options.event.profileId !== EVENT_PROFILE_ID || options.event.nasEventId !== NAS_EVENT_ID) throw new Error("NAS_EVENT_PROFILE_INVALID");
  if (options.device.eventProfileId !== EVENT_PROFILE_ID || options.device.eventId !== NAS_EVENT_ID) throw new Error("NAS_DEVICE_EVENT_INVALID");
  if (!path.isAbsolute(options.runtimeRoot)) throw new Error("NAS_RUNTIME_ROOT_INVALID");
  if (options.sessionKind !== "official" && options.sessionKind !== "practice") throw new Error("NAS_SESSION_KIND_INVALID");
}
