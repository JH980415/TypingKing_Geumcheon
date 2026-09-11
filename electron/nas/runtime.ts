import { randomUUID } from "node:crypto";
import path from "node:path";
import { createActiveAttemptStore } from "../activeAttemptStore";
import {
  createGeumcheonRecordRuntime,
  type AttemptPersistenceIdentity,
} from "../geumcheonRecordRuntime";
import type { DeviceProfile, EventProfile, RecordRow, SaveRecordInput, SessionKind } from "../../shared/types";
import { RECORD_HEADERS } from "../../shared/constants/defaults";
import {
  createGeumcheonAttemptIdentity,
  type GeumcheonAttemptIdentityIds,
  type NasRecordEnvelopeV1,
  type NasSessionV1,
} from "../../shared/nas/protocol";
import { NasAdminSession, type AdminActionBase } from "./adminSession";
import { NasApiClient, type FetchLike, type TimerAdapter } from "./apiClient";
import { NasCredentialStore, type SafeStorageAdapter } from "./credentialStore";
import { NasLeaderboardClient } from "./leaderboardClient";
import { EncryptedNasOutbox } from "./outbox";
import { NasRetryWorker, type RetryFlushResult } from "./retryWorker";

const EVENT_PROFILE_ID = "geumcheon-2026";
const NAS_EVENT_ID = "geumcheon-science-festival-2026";
const READ_ONLY_RECORD_METADATA = new Set([
  "fairness", "attemptNumber", "rankingEligible", "participantKey", "serverReceivedAt",
  "completionStatus", "totalTypingUnits", "totalUserTimeMs", "canonicalAttempt", "recordEvidence"
]);

export type GeumcheonLocalCallbacks = {
  persist(
    input: SaveRecordInput,
    recordId: string,
    identity: AttemptPersistenceIdentity,
  ): Promise<RecordRow>;
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
  executionRole?: "player" | "leaderboard";
  onReadSuccess?: () => void;
  credentials?: { getToken(role: "writer" | "leaderboard"): Promise<string> | string; assertCurrent(): void; assertLocalIdentity?():void };
  runtimeRoot: string;
  safeStorage: SafeStorageAdapter;
  fetch: FetchLike;
  local: GeumcheonLocalCallbacks;
  createAttemptIdentity?: () => GeumcheonAttemptIdentityIds;
  createActionId?: () => string;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  timers?: TimerAdapter;
};

export type GeumcheonNasRuntime = {
  importToken(token: string): Promise<void>;
  importLeaderboardToken(token: string): Promise<void>;
  importOperatorToken(token: string): Promise<void>;
  checkReady(): ReturnType<NasApiClient["getReady"]>;
  checkOperatorReady(): ReturnType<NasApiClient["getReady"]>;
  checkLeaderboardReady(): ReturnType<NasApiClient["getReady"]>;
  checkpoint(input: SaveRecordInput): ReturnType<ReturnType<typeof createGeumcheonRecordRuntime>["checkpoint"]>;
  save(input: SaveRecordInput): Promise<RecordRow>;
  recover(): Promise<RecordRow | null>;
  flush(): Promise<RetryFlushResult>;
  queueStatus(): Promise<{ pending: number; blocked: number }>;
  loadRecords(options?: { freshOnly?: boolean }): ReturnType<NasLeaderboardClient["load"]>;
  edit(recordId: string, replacement: RecordRow, adminName: string): Promise<unknown>;
  hide(recordId: string, hidden: boolean, adminName: string): Promise<unknown>;
  resetSession(adminName: string): Promise<unknown>;
};

export function createGeumcheonNasRuntime(options: GeumcheonNasRuntimeOptions): GeumcheonNasRuntime {
  validateOptions(options);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const session = sessionFor(options.device, options.sessionKind);
  const writerCredentials = new NasCredentialStore({
    filePath: path.join(runtimeRoot, "nas", "device-token.bin"),
    safeStorage: options.safeStorage,
    eventId: options.event.nasEventId,
    deviceId: options.device.deviceId,
    apiBaseUrl: options.device.apiBaseUrl
  });
  const leaderboardCredentials = new NasCredentialStore({
    filePath: path.join(runtimeRoot, "nas", "leaderboard-token.bin"),
    safeStorage: options.safeStorage,
    eventId: options.event.nasEventId,
    deviceId: options.device.deviceId,
    apiBaseUrl: options.device.apiBaseUrl
  });
  const operatorCredentials = new NasCredentialStore({
    filePath: path.join(runtimeRoot, "nas", "operator-token.bin"),
    safeStorage: options.safeStorage,
    eventId: options.event.nasEventId,
    deviceId: options.device.deviceId,
    apiBaseUrl: options.device.apiBaseUrl
  });
  const outbox = new EncryptedNasOutbox({ rootDir: path.join(runtimeRoot, "nas", "outbox"), safeStorage: options.safeStorage });
  const writerApi = new NasApiClient({
    baseUrl: options.device.apiBaseUrl,
    deviceId: options.device.deviceId,
    getToken: async () => {options.credentials?.assertCurrent();return options.credentials ? options.credentials.getToken("writer") : writerCredentials.getToken();},
    fetch: options.fetch,
    requestTimeoutMs: options.device.requestTimeoutMs,
    timers: options.timers,
  });
  const leaderboardApi = new NasApiClient({
    baseUrl: options.device.apiBaseUrl,
    deviceId: options.device.deviceId,
    getToken: async () => {options.credentials?.assertCurrent();return options.credentials ? options.credentials.getToken("leaderboard") : leaderboardCredentials.getToken();},
    fetch: options.fetch,
    requestTimeoutMs: options.device.requestTimeoutMs,
    timers: options.timers,
  });
  const operatorApi = new NasApiClient({
    baseUrl: options.device.apiBaseUrl,
    deviceId: options.device.deviceId,
    getToken: () => options.credentials ? Promise.reject(new Error("NAS_OPERATOR_NOT_PROVISIONED")) : operatorCredentials.getToken(),
    fetch: options.fetch,
    requestTimeoutMs: options.device.requestTimeoutMs,
    timers: options.timers,
  });
  const retry = new NasRetryWorker({
    outbox,
    transport: writerApi,
    initialDelayMs: options.device.retry.initialDelayMs,
    maxDelayMs: options.device.retry.maxDelayMs,
    maxAttempts: 4,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))),
  });
  const leaderboard = new NasLeaderboardClient(leaderboardApi);
  const admin = new NasAdminSession(operatorApi);
  const activeStore = createActiveAttemptStore({
    checkpointPath: path.join(runtimeRoot, "nas", `active-attempt-${options.sessionKind}.bin`),
    encryption: options.safeStorage,
    eventProfileId: EVENT_PROFILE_ID,
  });
  const now = options.now ?? (() => new Date().toISOString());
  const createAttemptIdentity = options.createAttemptIdentity
    ?? (() => createGeumcheonAttemptIdentity(options.device.deviceId, randomUUID));
  const createActionId = options.createActionId ?? (() => `gsc26-action-${randomUUID()}`);
  const records = createGeumcheonRecordRuntime({
    eventProfileId: EVENT_PROFILE_ID,
    variant: options.sessionKind === "official" ? "ai" : "practice",
    deviceId: options.device.deviceId,
    store: {
      save: (checkpoint) => activeStore.save(checkpoint),
      read: () => activeStore.read(),
      clear: () => activeStore.clear(),
    },
    createAttemptIdentity,
    now,
    persistLocal: (input, identity) => options.local.persist(
      input,
      identity.recordId,
      identity,
    ),
    enqueue: (row) => outbox.enqueue(options.sessionKind, {
      schema_version: 1,
      event_id: NAS_EVENT_ID,
      session,
      row,
    } as unknown as NasRecordEnvelopeV1),
  });
  let lastKnownGood: Awaited<ReturnType<NasLeaderboardClient["load"]>> | undefined;

  function requireRole(role: "player" | "leaderboard"): void {
    options.credentials?.assertLocalIdentity?.();
    if ((options.executionRole ?? options.device.role) !== role || (role === "player" && options.device.role !== "player")) throw new Error("NAS_ROLE_FORBIDDEN");
  }

  async function assertExistingAttemptOrCurrentProfile():Promise<void> {
    if(!(await activeStore.read()))options.credentials?.assertCurrent();
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
    importToken: async (token) => { requireRole("player"); await writerCredentials.importToken(token); },
    importLeaderboardToken: async (token) => { await leaderboardCredentials.importToken(token); },
    importOperatorToken: async (token) => { requireRole("leaderboard"); await operatorCredentials.importToken(token); },
    checkReady: () => (options.executionRole ?? options.device.role) === "player"
      ? writerApi.getReady(session, { eventId: NAS_EVENT_ID, role: "writer" })
      : leaderboardApi.getReady(session, { eventId: NAS_EVENT_ID, role: "leaderboard" }),
    checkLeaderboardReady: () => leaderboardApi.getReady(session, { eventId: NAS_EVENT_ID, role: "leaderboard" }),
    checkOperatorReady: () => {
      requireRole("leaderboard");
      return operatorApi.getReady(session, { eventId: NAS_EVENT_ID, role: "operator" });
    },
    checkpoint: async (input) => { requireRole("player"); await assertExistingAttemptOrCurrentProfile(); return records.checkpoint(input); },
    save: async (input) => { requireRole("player"); await assertExistingAttemptOrCurrentProfile(); return records.save(input); },
    recover: async () => { requireRole("player"); return records.recover(); },
    flush: async () => { requireRole("player"); return retry.flush(options.sessionKind); },
    queueStatus: async () => {
      const [pending, blocked] = await Promise.all([outbox.list(options.sessionKind), outbox.listBlocked(options.sessionKind)]);
      return { pending: pending.length, blocked: blocked.length };
    },
    loadRecords: async (readOptions) => {
      if(options.credentials) options.credentials.assertCurrent(); else requireRole("leaderboard");
      try {
        await leaderboardApi.getReady(session, { eventId: NAS_EVENT_ID, role: "leaderboard" });
        lastKnownGood = await leaderboard.load(session);
        options.onReadSuccess?.();
        return lastKnownGood;
      } catch (error) {
        if (!readOptions?.freshOnly && lastKnownGood != null) return lastKnownGood;
        throw error;
      }
    },
    edit: (recordId, replacement, adminName) => {
      if (replacement == null || typeof replacement !== "object" || Array.isArray(replacement) ||
        (Object.getPrototypeOf(replacement) !== Object.prototype && Object.getPrototypeOf(replacement) !== null)) {
        return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_INVALID"));
      }
      if (replacement.record_id !== recordId) return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_ID_MISMATCH"));
      const changes: Partial<RecordRow> = {};
      for (const [key, value] of Object.entries(replacement)) {
        if (key === "record_id" || READ_ONLY_RECORD_METADATA.has(key)) continue;
        if (!RECORD_HEADERS.includes(key as typeof RECORD_HEADERS[number])) {
          return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_FIELD_INVALID"));
        }
        if (typeof value !== "string") return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_INVALID"));
        changes[key as typeof RECORD_HEADERS[number]] = value;
      }
      if (Object.keys(changes).length === 0) return Promise.reject(new Error("NAS_ADMIN_REPLACEMENT_INVALID"));
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
  if (device.sessions.practice === undefined) throw new Error("NAS_PRACTICE_SESSION_NOT_CONFIGURED");
  return { kind, session_id: device.sessions.practice.sessionId };
}

function validateOptions(options: GeumcheonNasRuntimeOptions): void {
  if (options.event.profileId !== EVENT_PROFILE_ID || options.event.nasEventId !== NAS_EVENT_ID) throw new Error("NAS_EVENT_PROFILE_INVALID");
  if (options.device.eventProfileId !== EVENT_PROFILE_ID || options.device.eventId !== NAS_EVENT_ID) throw new Error("NAS_DEVICE_EVENT_INVALID");
  if (!path.isAbsolute(options.runtimeRoot)) throw new Error("NAS_RUNTIME_ROOT_INVALID");
  if (options.sessionKind !== "official" && options.sessionKind !== "practice") throw new Error("NAS_SESSION_KIND_INVALID");
}
