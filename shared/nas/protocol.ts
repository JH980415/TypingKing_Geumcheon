import { createHash } from "node:crypto";

import type { DeviceProfile, SessionKind } from "../events/types";
import type { RecordRow } from "../types";

export const GEUMCHEON_NAS_EVENT_ID = "geumcheon-science-festival-2026" as const;

export type NasSessionV1 =
  | { kind: "official"; session_id: string; day_no: number; round_no: number }
  | { kind: "practice"; session_id: string };

export type NasRecordEnvelopeV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  row: RecordRow;
};

export type NasRecordAckV1 = {
  schema_version: 1;
  disposition: "stored" | "duplicate";
  record_id: string;
  payload_sha256: string;
  stored_sha256: string;
  received_at: string;
};

export type NasRecordsSnapshotV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  generated_at: string;
  rows: RecordRow[];
};

export type NasLeaderboardSnapshotV1 = NasRecordsSnapshotV1;

type NasAdminActionBaseV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  action_id: string;
  created_at: string;
  admin_name: string;
};

export type NasAdminActionV1 =
  | (NasAdminActionBaseV1 & {
      action_type: "edit";
      target_record_id: string;
      changes: Partial<RecordRow>;
    })
  | (NasAdminActionBaseV1 & {
      action_type: "hide";
      target_record_id: string;
      hidden: boolean;
    })
  | (NasAdminActionBaseV1 & {
      action_type: "reset_session";
    });

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECORD_ID = new RegExp(`^gsc26-pc(?:0[1-9]|10)-${UUID_V4}$`);
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export function createGeumcheonRecordId(deviceId: string, uuidV4: () => string): string {
  const normalizedDeviceId = deviceId.toLowerCase();
  if (!/^pc(?:0[1-9]|10)$/.test(normalizedDeviceId)) {
    throw new Error("NAS_RECORD_ID_INVALID_DEVICE");
  }

  const uuid = uuidV4().toLowerCase();
  if (!new RegExp(`^${UUID_V4}$`).test(uuid)) {
    throw new Error("NAS_RECORD_ID_INVALID_UUID");
  }
  return `gsc26-${normalizedDeviceId}-${uuid}`;
}

export function isGeumcheonRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function buildNasRecordEnvelope(
  profile: DeviceProfile,
  kind: SessionKind,
  row: RecordRow,
): NasRecordEnvelopeV1 {
  if (profile.eventId !== GEUMCHEON_NAS_EVENT_ID) {
    throw new Error("NAS_EVENT_ID_INVALID");
  }
  if (profile.role !== "player") {
    throw new Error("NAS_RECORD_DEVICE_ROLE_INVALID");
  }
  if (!isGeumcheonRecordId(row.record_id)) {
    throw new Error("NAS_RECORD_ID_INVALID");
  }
  if (!row.record_id.startsWith(`gsc26-${profile.deviceId.toLowerCase()}-`)) {
    throw new Error("NAS_RECORD_DEVICE_MISMATCH");
  }

  return {
    schema_version: 1,
    event_id: GEUMCHEON_NAS_EVENT_ID,
    session: sessionFor(profile, kind),
    row,
  };
}

export function assertNasRecordAck(
  value: unknown,
  recordId: string,
  payloadHash: string,
): asserts value is NasRecordAckV1 {
  assertPlainObject(value, "NAS_RECORD_ACK_INVALID");
  assertExactObject(value, [
    "schema_version",
    "disposition",
    "record_id",
    "payload_sha256",
    "stored_sha256",
    "received_at",
  ], "NAS_RECORD_ACK_INVALID");

  if (value.schema_version !== 1) throw new Error("NAS_RECORD_ACK_SCHEMA_INVALID");
  if (value.disposition !== "stored" && value.disposition !== "duplicate") {
    throw new Error("NAS_RECORD_ACK_DISPOSITION_INVALID");
  }
  if (!isGeumcheonRecordId(value.record_id) || value.record_id !== recordId) {
    throw new Error("NAS_RECORD_ACK_RECORD_ID_INVALID");
  }
  if (!SHA256.test(payloadHash) || value.payload_sha256 !== payloadHash) {
    throw new Error("NAS_RECORD_ACK_PAYLOAD_HASH_MISMATCH");
  }
  if (typeof value.stored_sha256 !== "string" || !SHA256.test(value.stored_sha256)) {
    throw new Error("NAS_RECORD_ACK_STORED_HASH_INVALID");
  }
  assertIsoTimestamp(value.received_at, "NAS_RECORD_ACK_RECEIVED_AT_INVALID");
}

export function assertNasLeaderboardSnapshot(
  value: unknown,
): asserts value is NasLeaderboardSnapshotV1 {
  assertPlainObject(value, "NAS_RECORDS_SNAPSHOT_INVALID");
  assertExactObject(value, [
    "schema_version",
    "event_id",
    "session",
    "generated_at",
    "rows",
  ], "NAS_RECORDS_SNAPSHOT_INVALID");

  if (value.schema_version !== 1) throw new Error("NAS_RECORDS_SNAPSHOT_SCHEMA_INVALID");
  if (value.event_id !== GEUMCHEON_NAS_EVENT_ID) {
    throw new Error("NAS_RECORDS_SNAPSHOT_EVENT_INVALID");
  }
  assertSession(value.session);
  assertIsoTimestamp(value.generated_at, "NAS_RECORDS_SNAPSHOT_TIMESTAMP_INVALID");
  if (!Array.isArray(value.rows)) throw new Error("NAS_RECORDS_SNAPSHOT_ROWS_INVALID");

  for (const row of value.rows) {
    assertPlainObject(row, "NAS_RECORDS_ROW_INVALID");
    if (!isGeumcheonRecordId(row.record_id)) {
      throw new Error("NAS_RECORDS_ROW_INVALID");
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_NUMBER_MUST_BE_FINITE");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) throw new Error("CANONICAL_VALUE_INVALID");

  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalize(value[key]);
  }
  return output;
}

function sessionFor(profile: DeviceProfile, kind: SessionKind): NasSessionV1 {
  if (kind === "practice") {
    const sessionId = profile.sessions.practice.sessionId;
    assertNonEmptyString(sessionId, "NAS_SESSION_INVALID");
    return { kind, session_id: sessionId };
  }

  const session = profile.sessions.official;
  assertNonEmptyString(session.sessionId, "NAS_SESSION_INVALID");
  assertPositiveInteger(session.dayNo, "NAS_SESSION_INVALID");
  assertPositiveInteger(session.roundNo, "NAS_SESSION_INVALID");
  return {
    kind,
    session_id: session.sessionId,
    day_no: session.dayNo,
    round_no: session.roundNo,
  };
}

function assertSession(value: unknown): asserts value is NasSessionV1 {
  assertPlainObject(value, "NAS_SESSION_INVALID");
  if (value.kind === "practice") {
    assertExactObject(value, ["kind", "session_id"], "NAS_SESSION_INVALID");
    assertNonEmptyString(value.session_id, "NAS_SESSION_INVALID");
    return;
  }
  if (value.kind === "official") {
    assertExactObject(value, ["kind", "session_id", "day_no", "round_no"], "NAS_SESSION_INVALID");
    assertNonEmptyString(value.session_id, "NAS_SESSION_INVALID");
    assertPositiveInteger(value.day_no, "NAS_SESSION_INVALID");
    assertPositiveInteger(value.round_no, "NAS_SESSION_INVALID");
    return;
  }
  throw new Error("NAS_SESSION_INVALID");
}

function assertExactObject(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

function assertPlainObject(
  value: unknown,
  code: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
}

function assertPositiveInteger(value: unknown, code: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(code);
}

function assertIsoTimestamp(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== "string"
    || !ISO_TIMESTAMP.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new Error(code);
  }
}
