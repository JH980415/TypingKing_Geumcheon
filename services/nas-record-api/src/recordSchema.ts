import { createHmac } from "node:crypto";

import type { StageText } from "../../../shared/types/index.js";
import {
  GEUMCHEON_NAS_EVENT_ID,
  canonicalStringify,
  isGeumcheonRecordId,
  payloadSha256,
  type NasRecordEnvelopeV1,
  type NasSessionV1,
  type NasStageAttemptV1,
} from "../../../shared/nas/protocol.js";
import { maskBirthdate, maskPhone } from "../../../shared/utils/masking.js";
import {
  calculateFinalCpm,
  calculateTotalUserTimeMs,
  countConvertedTypingUnits,
} from "../../../shared/utils/typing.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import type { NasServerConfigV1 } from "./config.js";

const MAX_CANONICAL_BODY_BYTES = 32 * 1024;

export type RecordValidationConfigV1 = NasServerConfigV1 & {
  stageTextCatalog: readonly StageText[];
  participantHmacKey: Uint8Array;
};

export type StoredNasStageV1 = NasStageAttemptV1 & { typing_units: number };

export type StoredNasRecordV1 = {
  schema_version: 1;
  event_id: typeof GEUMCHEON_NAS_EVENT_ID;
  session: NasSessionV1;
  payload_sha256: string;
  record: {
    record_id: string;
    created_at: string;
    completed_at: string;
    participant: {
      name: string;
      phone: string;
      phone_masked: string;
      birthdate: string;
      birthdate_masked: string;
      privacy_agreed: true;
      privacy_agreed_at: string;
    };
    participant_key: string;
    status: "success" | "failed" | "interrupted";
    stages: StoredNasStageV1[];
    app_version: string;
    is_test: boolean;
    is_debug: boolean;
    debug_mode_type: "" | "normal_typing_debug" | "ai_challenge_debug";
    interruption_action?: "home" | "retry";
    authenticated_device_id: string;
    total_typing_units: number;
    total_user_time_ms: number;
    effective_cpm_numerator: number;
    effective_cpm_denominator: number;
    display_cpm: number;
    received_at: string;
  };
};

export function validateAndNormalizeRecord(
  body: unknown,
  authenticatedDevice: AuthenticatedPrincipal,
  config: RecordValidationConfigV1,
  receivedAt: string,
): StoredNasRecordV1 {
  let canonicalBody: string;
  try {
    canonicalBody = canonicalStringify(body);
  } catch {
    throw new Error("BODY_INVALID");
  }
  if (Buffer.byteLength(canonicalBody, "utf8") > MAX_CANONICAL_BODY_BYTES) throw new Error("BODY_TOO_LARGE");

  if (authenticatedDevice.role !== "writer") throw new Error("ROLE_SCOPE");
  if (authenticatedDevice.eventId !== config.eventId || config.eventId !== GEUMCHEON_NAS_EVENT_ID) throw new Error("EVENT_SCOPE");
  if (config.participantHmacKey.byteLength < 32) throw new Error("HMAC_KEY_INVALID");

  const envelope = exactObject(body, ["schema_version", "event_id", "session", "record"], "ENVELOPE");
  if (envelope.schema_version !== 1) throw new Error("SCHEMA_VERSION_INVALID");
  if (envelope.event_id !== GEUMCHEON_NAS_EVENT_ID || envelope.event_id !== authenticatedDevice.eventId) throw new Error("EVENT_SCOPE");

  const session = validateSession(envelope.session, authenticatedDevice, config);
  const recordObject = exactObject(
    envelope.record,
    [
      "record_id",
      "created_at",
      "completed_at",
      "participant",
      "status",
      "stages",
      "app_version",
      "is_test",
      "is_debug",
      "debug_mode_type",
      "interruption_action",
    ],
    "RECORD",
    ["interruption_action"],
  );

  const recordId = stringValue(recordObject.record_id, "RECORD_ID_INVALID");
  if (!isGeumcheonRecordId(recordId)) throw new Error("RECORD_ID_INVALID");
  if (!recordId.startsWith(`gsc26-${authenticatedDevice.deviceId.toLowerCase()}-`)) throw new Error("DEVICE_SCOPE");

  const receivedAtValue = timestamp(receivedAt, "RECEIVED_AT_INVALID");
  const createdAt = timestamp(recordObject.created_at, "CREATED_AT_INVALID");
  const completedAt = timestamp(recordObject.completed_at, "COMPLETED_AT_INVALID");
  if (Date.parse(createdAt) > Date.parse(completedAt) || Date.parse(completedAt) > Date.parse(receivedAtValue)) {
    throw new Error("TIMESTAMP_ORDER_INVALID");
  }

  const participantObject = exactObject(
    recordObject.participant,
    ["name", "phone", "birthdate", "privacy_agreed", "privacy_agreed_at"],
    "PARTICIPANT",
  );
  const participantName = participantNameValue(participantObject.name);
  const phone = normalizedPhone(participantObject.phone);
  const birthdate = calendarDate(participantObject.birthdate, receivedAtValue);
  if (participantObject.privacy_agreed !== true) throw new Error("CONSENT_REQUIRED");
  const privacyAgreedAt = timestamp(participantObject.privacy_agreed_at, "CONSENT_TIME_INVALID");
  if (Date.parse(privacyAgreedAt) > Date.parse(completedAt)) throw new Error("CONSENT_TIME_INVALID");

  if (recordObject.status !== "success" && recordObject.status !== "failed" && recordObject.status !== "interrupted") {
    throw new Error("STATUS_INVALID");
  }
  if (!Array.isArray(recordObject.stages) || recordObject.stages.length < 1 || recordObject.stages.length > 3) {
    throw new Error("STAGE_COUNT_INVALID");
  }

  const ranges = config.aiRanges[session.kind];
  const stages = recordObject.stages.map((stage, index) => validateStage(stage, index, ranges[index]!, config.stageTextCatalog));
  validateStatus(recordObject.status, stages);

  const appVersion = stringValue(recordObject.app_version, "APP_VERSION_INVALID");
  if (appVersion.length > 128) throw new Error("APP_VERSION_INVALID");
  if (typeof recordObject.is_test !== "boolean" || typeof recordObject.is_debug !== "boolean") throw new Error("FLAG_INVALID");
  if (recordObject.debug_mode_type !== "" && recordObject.debug_mode_type !== "normal_typing_debug" && recordObject.debug_mode_type !== "ai_challenge_debug") {
    throw new Error("DEBUG_MODE_INVALID");
  }
  if ((recordObject.is_debug && recordObject.debug_mode_type === "") || (!recordObject.is_debug && recordObject.debug_mode_type !== "")) {
    throw new Error("DEBUG_MODE_INVALID");
  }

  const interruptionAction = recordObject.interruption_action;
  if (interruptionAction !== undefined) {
    if (recordObject.status !== "interrupted" || (interruptionAction !== "home" && interruptionAction !== "retry")) {
      throw new Error("INTERRUPTION_ACTION_INVALID");
    }
  }

  const totalTypingUnits = stages.reduce((sum, stage) => sum + stage.typing_units, 0);
  const totalUserTimeMs = calculateTotalUserTimeMs(stages.map((stage) => stage.user_time_ms));
  const effectiveCpmNumerator = totalTypingUnits * 60_000;
  if (!Number.isSafeInteger(effectiveCpmNumerator)) throw new Error("CPM_DERIVATIVE_INVALID");
  const participantKey = createHmac("sha256", config.participantHmacKey).update(phone, "utf8").digest("hex");

  return {
    schema_version: 1,
    event_id: GEUMCHEON_NAS_EVENT_ID,
    session,
    payload_sha256: payloadSha256(body),
    record: {
      record_id: recordId,
      created_at: createdAt,
      completed_at: completedAt,
      participant: {
        name: participantName,
        phone,
        phone_masked: maskPhone(phone),
        birthdate,
        birthdate_masked: maskBirthdate(birthdate),
        privacy_agreed: true,
        privacy_agreed_at: privacyAgreedAt,
      },
      participant_key: participantKey,
      status: recordObject.status,
      stages,
      app_version: appVersion,
      is_test: recordObject.is_test,
      is_debug: recordObject.is_debug,
      debug_mode_type: recordObject.debug_mode_type,
      ...(interruptionAction === "home" || interruptionAction === "retry" ? { interruption_action: interruptionAction } : {}),
      authenticated_device_id: authenticatedDevice.deviceId,
      total_typing_units: totalTypingUnits,
      total_user_time_ms: totalUserTimeMs,
      effective_cpm_numerator: effectiveCpmNumerator,
      effective_cpm_denominator: totalUserTimeMs,
      display_cpm: calculateFinalCpm(totalTypingUnits, totalUserTimeMs),
      received_at: receivedAtValue,
    },
  };
}

function validateSession(
  value: unknown,
  principal: AuthenticatedPrincipal,
  config: RecordValidationConfigV1,
): NasSessionV1 {
  const base = exactObject(value, ["kind", "session_id", "day_no", "round_no"], "SESSION", ["day_no", "round_no"]);
  const sessionId = stringValue(base.session_id, "SESSION_INVALID");
  if (base.kind !== "official" && base.kind !== "practice") throw new Error("SESSION_INVALID");
  if (!principal.allowedSessions.includes(base.kind)) throw new Error("SESSION_SCOPE");
  if (base.kind === "practice") {
    if ("day_no" in base || "round_no" in base || sessionId !== config.allowedSessions.practice.sessionId) throw new Error("SESSION_SCOPE");
    return { kind: "practice", session_id: sessionId };
  }
  const dayNo = positiveInteger(base.day_no, "SESSION_INVALID");
  const roundNo = positiveInteger(base.round_no, "SESSION_INVALID");
  const allowed = config.allowedSessions.official.some(
    (session) => session.sessionId === sessionId && session.dayNo === dayNo && session.roundNo === roundNo,
  );
  if (!allowed) throw new Error("SESSION_SCOPE");
  return { kind: "official", session_id: sessionId, day_no: dayNo, round_no: roundNo };
}

function validateStage(
  value: unknown,
  index: number,
  aiRange: readonly [number, number],
  catalog: readonly StageText[],
): StoredNasStageV1 {
  const stage = exactObject(value, [
    "stage_no",
    "text_id",
    "catalog_version",
    "target_text",
    "typed_text",
    "user_time_ms",
    "ai_cpm",
    "result",
  ], "STAGE");
  const stageNo = index + 1;
  if (stage.stage_no !== stageNo || stageNo > 3) throw new Error("STAGE_ORDER");
  const textId = stringValue(stage.text_id, "PHRASE_MISMATCH");
  const catalogVersion = stringValue(stage.catalog_version, "PHRASE_MISMATCH");
  const targetText = stringValue(stage.target_text, "PHRASE_MISMATCH", true);
  if (typeof stage.typed_text !== "string") throw new Error("TYPED_PREFIX");
  const typedText = stage.typed_text;
  const catalogEntry = catalog.find((entry) => entry.id === textId);
  if (
    catalogEntry == null
    || catalogEntry.catalog_version !== catalogVersion
    || catalogEntry.text !== targetText
    || catalogEntry.stage_number !== String(stageNo)
    || catalogEntry.game_mode !== "ai_challenge"
    || catalogEntry.is_active !== "true"
  ) {
    throw new Error("PHRASE_MISMATCH");
  }
  if (!targetText.startsWith(typedText)) throw new Error("TYPED_PREFIX");
  const userTimeMs = positiveInteger(stage.user_time_ms, "TIME_INVALID");
  const aiCpm = positiveInteger(stage.ai_cpm, "AI_RANGE");
  if (aiCpm < aiRange[0] || aiCpm > aiRange[1]) throw new Error("AI_RANGE");
  if (stage.result !== "USER_WIN" && stage.result !== "AI_WIN" && stage.result !== "INTERRUPTED") throw new Error("RESULT_INVALID");
  if (stage.result === "USER_WIN" ? typedText !== targetText : typedText === targetText) throw new Error("RESULT_MISMATCH");
  return {
    stage_no: stageNo as 1 | 2 | 3,
    text_id: textId,
    catalog_version: catalogVersion,
    target_text: targetText,
    typed_text: typedText,
    user_time_ms: userTimeMs,
    ai_cpm: aiCpm,
    result: stage.result,
    typing_units: countConvertedTypingUnits(typedText),
  };
}

function validateStatus(status: "success" | "failed" | "interrupted", stages: readonly StoredNasStageV1[]): void {
  const preceding = stages.slice(0, -1);
  if (preceding.some((stage) => stage.result !== "USER_WIN")) throw new Error("STATUS_MISMATCH");
  const finalResult = stages.at(-1)?.result;
  if (status === "success" && stages.length === 3 && stages.every((stage) => stage.result === "USER_WIN")) return;
  if (status === "failed" && finalResult === "AI_WIN") return;
  if (status === "interrupted" && finalResult === "INTERRUPTED") return;
  throw new Error("STATUS_MISMATCH");
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  prefix: string,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${prefix}_OBJECT_INVALID`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${prefix}_OBJECT_INVALID`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`${prefix}_UNKNOWN_KEY`);
  for (const key of keys) if (!optionalKeys.includes(key) && !(key in object)) throw new Error(`${prefix}_MISSING_KEY`);
  return object;
}

function stringValue(value: unknown, code: string, allowWhitespace = false): string {
  if (typeof value !== "string" || (!allowWhitespace && value.trim() === "") || (allowWhitespace && value.length === 0)) throw new Error(code);
  return value;
}

function participantNameValue(value: unknown): string {
  const name = stringValue(value, "PARTICIPANT_NAME_INVALID").trim();
  if (name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("PARTICIPANT_NAME_INVALID");
  return name;
}

function normalizedPhone(value: unknown): string {
  if (typeof value !== "string" || !/^(?:010\d{8}|010-\d{4}-\d{4})$/.test(value)) throw new Error("PHONE_INVALID");
  const digits = value.replace(/-/g, "");
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function calendarDate(value: unknown, receivedAt: string): string {
  if (typeof value !== "string") throw new Error("BIRTHDATE_INVALID");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match == null) throw new Error("BIRTHDATE_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || value > receivedAt.slice(0, 10)
  ) {
    throw new Error("BIRTHDATE_INVALID");
  }
  return value;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (match == null) throw new Error(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (
    year < 1
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || Number.isNaN(Date.parse(value))
  ) {
    throw new Error(code);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(code);
  return value as number;
}
