import { createHash } from "node:crypto";
import type { DeviceProfile, SessionKind } from "../events/types";
import type { GeumcheonFairnessInput, GeumcheonStageResultInput, RecordRow } from "../types";

export const GEUMCHEON_NAS_EVENT_ID = "geumcheon-science-festival-2026" as const;

export type NasSessionV1 =
  | { kind: "official"; session_id: string; day_no: number; round_no: number }
  | { kind: "practice"; session_id: string };

export type NasStageAttemptV1 = {
  stage_no: 1 | 2 | 3;
  text_id: string;
  catalog_version: string;
  target_text: string;
  typed_text: string;
  user_time_ms: number;
  ai_cpm: number;
  result: "USER_WIN" | "AI_WIN" | "INTERRUPTED";
};

export type NasRecordEnvelopeV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  record: {
    record_id: string;
    created_at: string;
    completed_at: string;
    participant: {
      name: string;
      phone: string;
      birthdate: string;
      privacy_agreed: boolean;
      privacy_agreed_at: string;
    };
    status: "success" | "failed" | "interrupted";
    stages: NasStageAttemptV1[];
    app_version: string;
    is_test: boolean;
    is_debug: boolean;
    debug_mode_type: "" | "normal_typing_debug" | "ai_challenge_debug";
    interruption_action?: "home" | "retry";
  };
};

export type NasRecordAckV1 = {
  schema_version: 1;
  disposition: "stored" | "duplicate";
  record_id: string;
  payload_sha256: string;
  stored_sha256: string;
  received_at: string;
};

export type NasLeaderboardEntryV1 = {
  rank: number;
  record_id: string;
  display_name: string;
  phone_masked: string;
  display_cpm: number;
  total_user_time_ms: number;
  completed_at: string;
  result_stage: number;
  attempt_number: number;
};

export type NasLeaderboardSnapshotV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  generated_at: string;
  entries: NasLeaderboardEntryV1[];
};

export type NasVisibilityActionV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  action_id: string;
  record_id: string;
  hidden: boolean;
};

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECORD_ID = new RegExp(`^gsc26-pc(?:0[1-9]|10)-${UUID_V4}$`);
const ACTION_ID = new RegExp(`^gsc26-action-${UUID_V4}$`);
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DISPLAY_NAME_MASK = /^[^\s*]\*+(?:[^\s*])?$/u;
const PHONE_MASK = /^010-\*{4}-\d{4}$/;

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export function createGeumcheonRecordId(deviceId: string, uuidV4: () => string): string {
  const normalizedDeviceId = deviceId.toLowerCase();
  if (!/^pc(?:0[1-9]|10)$/.test(normalizedDeviceId)) throw new Error("NAS_RECORD_ID_INVALID_DEVICE");

  const uuid = uuidV4();
  if (!new RegExp(`^${UUID_V4}$`).test(uuid)) throw new Error("NAS_RECORD_ID_INVALID_UUID");
  return `gsc26-${normalizedDeviceId}-${uuid}`;
}

export function isGeumcheonRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function isGeumcheonVisibilityActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID.test(value);
}

export function buildNasRecordEnvelope(
  profile: DeviceProfile,
  kind: SessionKind,
  row: RecordRow,
  fairness: GeumcheonFairnessInput | undefined,
): NasRecordEnvelopeV1 {
  if (profile.eventId !== GEUMCHEON_NAS_EVENT_ID) throw new Error("NAS_EVENT_ID_INVALID");
  if (profile.role !== "player") throw new Error("NAS_RECORD_DEVICE_ROLE_INVALID");
  if (!isGeumcheonRecordId(row.record_id)) throw new Error("NAS_RECORD_ID_INVALID");
  if (!row.record_id.startsWith(`gsc26-${profile.deviceId.toLowerCase()}-`)) throw new Error("NAS_RECORD_DEVICE_MISMATCH");
  if (fairness == null) throw new Error("NAS_RECORD_FAIRNESS_REQUIRED");
  if (!Number.isFinite(fairness.totalUserTimeMs) || fairness.totalUserTimeMs <= 0) {
    throw new Error("NAS_RECORD_FAIRNESS_INVALID");
  }

  const session = sessionFor(profile, kind);
  const stages = fairness.stages.map((stage, index) => mapStage(stage, index));
  const status = statusFor(row, stages);
  assertStageStatus(status, stages);
  const action = interruptionAction(row.memo, status);

  return {
    schema_version: 1,
    event_id: GEUMCHEON_NAS_EVENT_ID,
    session,
    record: {
      record_id: row.record_id,
      created_at: requiredIsoTimestamp(row.created_at, "created_at"),
      completed_at: requiredIsoTimestamp(row.completed_at, "completed_at"),
      participant: {
        name: requiredString(row.participant_name, "participant_name"),
        phone: requiredString(row.phone_full, "phone_full"),
        birthdate: requiredString(row.birthdate, "birthdate"),
        privacy_agreed: parseBoolean(row.privacy_agreed, "privacy_agreed"),
        privacy_agreed_at: requiredIsoTimestamp(row.privacy_agreed_at, "privacy_agreed_at"),
      },
      status,
      stages,
      app_version: requiredString(row.app_version, "app_version"),
      is_test: parseBoolean(row.is_test, "is_test"),
      is_debug: parseBoolean(row.is_debug, "is_debug"),
      debug_mode_type: debugModeType(row.debug_mode_type),
      ...(action ? { interruption_action: action } : {}),
    },
  };
}

export function assertNasRecordAck(value: unknown, recordId: string, payloadHash: string): asserts value is NasRecordAckV1 {
  try {
    assertRecordId(recordId);
    assertSha256(payloadHash, "payload hash");
    assertExactObject(value, ["schema_version", "disposition", "record_id", "payload_sha256", "stored_sha256", "received_at"]);
    const ack = value as Record<string, unknown>;
    if (ack.schema_version !== 1) throw new Error("schema version");
    if (ack.disposition !== "stored" && ack.disposition !== "duplicate") throw new Error("disposition");
    assertRecordId(ack.record_id);
    assertSha256(ack.payload_sha256, "payload hash");
    assertSha256(ack.stored_sha256, "stored hash");
    assertIsoTimestamp(ack.received_at, "received_at");
    if (ack.record_id !== recordId) throw new Error("record ID");
    if (ack.payload_sha256 !== payloadHash) throw new Error("payload hash");
  } catch (error) {
    throw new Error(`NAS_RECORD_ACK_INVALID: ${messageFor(error)}`);
  }
}

export function assertNasLeaderboardSnapshot(value: unknown): asserts value is NasLeaderboardSnapshotV1 {
  try {
    assertExactObject(value, ["schema_version", "event_id", "session", "generated_at", "entries"]);
    const snapshot = value as Record<string, unknown>;
    if (snapshot.schema_version !== 1) throw new Error("schema_version");
    if (snapshot.event_id !== GEUMCHEON_NAS_EVENT_ID) throw new Error("event_id");
    assertNasSession(snapshot.session);
    assertIsoTimestamp(snapshot.generated_at, "generated_at");
    if (!Array.isArray(snapshot.entries)) throw new Error("entries");
    for (const entry of snapshot.entries) assertLeaderboardEntry(entry);
  } catch (error) {
    throw new Error(`PUBLIC_SNAPSHOT_INVALID: ${messageFor(error)}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_VALUE_NON_FINITE");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) throw new Error("CANONICAL_VALUE_INVALID");

  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sessionFor(profile: DeviceProfile, kind: SessionKind): NasSessionV1 {
  if (kind === "official") {
    const session = profile.sessions.official;
    if (!Number.isInteger(session.dayNo) || session.dayNo < 1 || !Number.isInteger(session.roundNo) || session.roundNo < 1) {
      throw new Error("NAS_OFFICIAL_SESSION_INVALID");
    }
    return { kind, session_id: requiredString(session.sessionId, "official_session_id"), day_no: session.dayNo, round_no: session.roundNo };
  }
  return { kind, session_id: requiredString(profile.sessions.practice.sessionId, "practice_session_id") };
}

function mapStage(stage: GeumcheonStageResultInput, index: number): NasStageAttemptV1 {
  if (stage.stageNumber !== index + 1 || stage.stageNumber < 1 || stage.stageNumber > 3) throw new Error("NAS_RECORD_STAGE_INVALID");
  if (!Number.isFinite(stage.userTimeMs) || stage.userTimeMs <= 0 || !Number.isFinite(stage.aiCpm) || stage.aiCpm <= 0) {
    throw new Error("NAS_RECORD_STAGE_INVALID");
  }
  if (stage.result !== "USER_WIN" && stage.result !== "AI_WIN" && stage.result !== "INTERRUPTED") {
    throw new Error("NAS_RECORD_STAGE_INVALID");
  }
  return {
    stage_no: stage.stageNumber,
    text_id: requiredString(stage.textId, "stage_text_id"),
    catalog_version: requiredString(stage.catalogVersion, "stage_catalog_version"),
    target_text: requiredString(stage.targetText, "stage_target_text"),
    typed_text: typeof stage.typedText === "string" ? stage.typedText : (() => { throw new Error("NAS_RECORD_STAGE_INVALID"); })(),
    user_time_ms: stage.userTimeMs,
    ai_cpm: stage.aiCpm,
    result: stage.result,
  };
}

function statusFor(row: RecordRow, stages: readonly NasStageAttemptV1[]): "success" | "failed" | "interrupted" {
  if (row.completionStatus === "success" || row.completionStatus === "completed") return "success";
  if (row.completionStatus === "failed") return "failed";
  if (row.completionStatus === "interrupted") return "interrupted";
  if (stages.some((stage) => stage.result === "INTERRUPTED")) return "interrupted";
  return stages.length === 3 && stages.every((stage) => stage.result === "USER_WIN") ? "success" : "failed";
}

function assertStageStatus(status: "success" | "failed" | "interrupted", stages: readonly NasStageAttemptV1[]): void {
  if (stages.length < 1 || stages.length > 3) throw new Error("NAS_RECORD_STAGE_INVALID");
  const finalResult = stages[stages.length - 1]?.result;
  const precedingStages = stages.slice(0, -1);
  if (precedingStages.some((stage) => stage.result !== "USER_WIN")) throw new Error("NAS_RECORD_STATUS_INVALID");
  if (status === "success" && stages.length === 3 && stages.every((stage) => stage.result === "USER_WIN")) return;
  if (status === "failed" && finalResult === "AI_WIN") return;
  if (status === "interrupted" && finalResult === "INTERRUPTED") return;
  throw new Error("NAS_RECORD_STATUS_INVALID");
}

function interruptionAction(memo: string | undefined, status: "success" | "failed" | "interrupted"): "home" | "retry" | undefined {
  if (status !== "interrupted" || typeof memo !== "string") return undefined;
  const match = /^중단:(home|retry)(?:\s|$)/.exec(memo);
  return match?.[1] as "home" | "retry" | undefined;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`NAS_RECORD_${field.toUpperCase()}_INVALID`);
}

function debugModeType(value: unknown): "" | "normal_typing_debug" | "ai_challenge_debug" {
  if (value === "" || value === "normal_typing_debug" || value === "ai_challenge_debug") return value;
  throw new Error("NAS_RECORD_DEBUG_MODE_INVALID");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`NAS_RECORD_${field.toUpperCase()}_INVALID`);
  return value;
}

function requiredIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  assertIsoTimestamp(timestamp, field);
  return timestamp;
}

function assertLeaderboardEntry(value: unknown): void {
  assertExactObject(value, ["rank", "record_id", "display_name", "phone_masked", "display_cpm", "total_user_time_ms", "completed_at", "result_stage", "attempt_number"]);
  const entry = value as Record<string, unknown>;
  assertPositiveInteger(entry.rank, "rank");
  assertRecordId(entry.record_id);
  assertNonEmptyString(entry.display_name, "display_name");
  assertNonEmptyString(entry.phone_masked, "phone_masked");
  if (!DISPLAY_NAME_MASK.test(entry.display_name as string)) throw new Error("display_name");
  if (!PHONE_MASK.test(entry.phone_masked as string)) throw new Error("phone_masked");
  assertNonNegativeInteger(entry.display_cpm, "display_cpm");
  assertPositiveInteger(entry.total_user_time_ms, "total_user_time_ms");
  assertIsoTimestamp(entry.completed_at, "completed_at");
  if (entry.result_stage !== 1 && entry.result_stage !== 2 && entry.result_stage !== 3) throw new Error("result_stage");
  assertPositiveInteger(entry.attempt_number, "attempt_number");
}

function assertNasSession(value: unknown): asserts value is NasSessionV1 {
  assertExactObject(value, ["kind", "session_id", "day_no", "round_no"], ["day_no", "round_no"]);
  const session = value as Record<string, unknown>;
  assertNonEmptyString(session.session_id, "session_id");
  if (session.kind === "official") {
    assertPositiveInteger(session.day_no, "day_no");
    assertPositiveInteger(session.round_no, "round_no");
    return;
  }
  if (session.kind !== "practice") throw new Error("session_kind");
  if ("day_no" in session || "round_no" in session) throw new Error("practice_session_fields");
}

function assertExactObject(value: unknown, keys: readonly string[], optionalKeys: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("object");
  const actualKeys = Object.keys(value);
  for (const key of actualKeys) if (!keys.includes(key)) throw new Error(`additional property ${key}`);
  for (const key of keys) if (!optionalKeys.includes(key) && !(key in value)) throw new Error(`missing property ${key}`);
}

function assertRecordId(value: unknown): asserts value is string {
  if (!isGeumcheonRecordId(value)) throw new Error("record_id");
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(field);
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new Error(field);
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(field);
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(field);
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(field);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
