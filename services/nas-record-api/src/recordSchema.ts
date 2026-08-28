import { RECORD_HEADERS } from "../../../shared/constants/defaults.js";
import type { NasRecordEnvelopeV1, NasSessionV1 } from "../../../shared/nas/protocol.js";
import {
  GEUMCHEON_NAS_EVENT_ID,
  canonicalStringify,
  isGeumcheonRecordId,
  payloadSha256,
} from "../../../shared/nas/protocol.js";
import type { RecordRow, StageText } from "../../../shared/types/index.js";
import { calculateFinalCpm, countTypeableChars } from "../../../shared/utils/typing.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import type { NasServerConfigV1 } from "./config.js";

const MAX_CANONICAL_BODY_BYTES = 32 * 1024;
const INTERRUPTION_MEMOS = new Set([
  "사용자 중단:메인화면",
  "사용자 중단:다시하기",
  "사용자 중단:프로그램 종료",
]);
const OPTIONAL_ROW_KEYS = new Set([
  "fairness",
  "attemptNumber",
  "rankingEligible",
  "participantKey",
  "serverReceivedAt",
  "completionStatus",
  "totalTypingUnits",
  "totalUserTimeMs",
]);

export type RecordValidationConfigV1 = NasServerConfigV1 & {
  stageTextCatalog: readonly StageText[];
  participantHmacKey: Uint8Array;
};

export type StoredNasRecordV1 = NasRecordEnvelopeV1 & {
  payload_sha256: string;
  authenticated_device_id: string;
  received_at: string;
};

export function validateAndNormalizeRecord(
  value: unknown,
  principal: AuthenticatedPrincipal,
  config: RecordValidationConfigV1,
  receivedAt: string,
): StoredNasRecordV1 {
  if (Buffer.byteLength(canonicalStringify(value), "utf8") > MAX_CANONICAL_BODY_BYTES) {
    throw new Error("BODY_TOO_LARGE");
  }

  const envelope = exactObject(value, ["schema_version", "event_id", "session", "row"], "ENVELOPE");
  if (envelope.schema_version !== 1) throw new Error("SCHEMA_VERSION_INVALID");
  if (
    envelope.event_id !== GEUMCHEON_NAS_EVENT_ID
    || envelope.event_id !== config.eventId
    || envelope.event_id !== principal.eventId
  ) {
    throw new Error("EVENT_ID_INVALID");
  }
  if (principal.role !== "writer") throw new Error("ROLE_SCOPE");

  const session = validateSession(envelope.session, principal, config);
  const row = validateRecordRow(envelope.row);
  if (!isGeumcheonRecordId(row.record_id)) throw new Error("RECORD_ID_INVALID");
  if (!row.record_id.startsWith(`gsc26-${principal.deviceId.toLowerCase()}-`)) {
    throw new Error("DEVICE_MISMATCH");
  }

  validateTimestamps(row, receivedAt);
  validateParticipant(row);
  validatePhrases(row, config.stageTextCatalog);
  validateRowSemantics(row);
  validateAiRanges(row, session, config);

  const normalizedEnvelope: NasRecordEnvelopeV1 = {
    schema_version: 1,
    event_id: GEUMCHEON_NAS_EVENT_ID,
    session,
    row,
  };
  return {
    ...normalizedEnvelope,
    payload_sha256: payloadSha256(normalizedEnvelope),
    authenticated_device_id: principal.deviceId,
    received_at: receivedAt,
  };
}

function validateRecordRow(value: unknown): RecordRow {
  const row = plainObject(value, "ROW_INVALID");
  const requiredKeys = new Set<string>(RECORD_HEADERS);
  for (const key of RECORD_HEADERS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) throw new Error("ROW_FIELD_MISSING");
    if (typeof row[key] !== "string") throw new Error("ROW_FIELD_INVALID");
  }
  for (const key of Object.keys(row)) {
    if (!requiredKeys.has(key) && !OPTIONAL_ROW_KEYS.has(key)) throw new Error("ROW_UNKNOWN_KEY");
  }
  return row as RecordRow;
}

function validateSession(
  value: unknown,
  principal: AuthenticatedPrincipal,
  config: RecordValidationConfigV1,
): NasSessionV1 {
  const session = plainObject(value, "SESSION_INVALID");
  if (session.kind !== "official" && session.kind !== "practice") {
    throw new Error("SESSION_INVALID");
  }
  if (!principal.allowedSessions.includes(session.kind)) throw new Error("SESSION_SCOPE");

  if (session.kind === "practice") {
    exactKeys(session, ["kind", "session_id"], "SESSION");
    if (session.session_id !== config.allowedSessions.practice.sessionId) {
      throw new Error("SESSION_INVALID");
    }
    return { kind: "practice", session_id: session.session_id };
  }

  exactKeys(session, ["kind", "session_id", "day_no", "round_no"], "SESSION");
  if (
    typeof session.session_id !== "string"
    || !Number.isInteger(session.day_no)
    || !Number.isInteger(session.round_no)
  ) {
    throw new Error("SESSION_INVALID");
  }
  const configured = config.allowedSessions.official.some((item) =>
    item.sessionId === session.session_id
    && item.dayNo === session.day_no
    && item.roundNo === session.round_no);
  if (!configured) throw new Error("SESSION_INVALID");
  return {
    kind: "official",
    session_id: session.session_id,
    day_no: session.day_no as number,
    round_no: session.round_no as number,
  };
}

function validateTimestamps(row: RecordRow, receivedAt: string): void {
  const created = timestamp(row.created_at, "CREATED_AT_INVALID");
  const completed = timestamp(row.completed_at, "COMPLETED_AT_INVALID");
  const received = timestamp(receivedAt, "RECEIVED_AT_INVALID");
  const consent = timestamp(row.privacy_agreed_at, "CONSENT_TIMESTAMP_INVALID");
  if (created > completed || completed > received || consent > completed) {
    throw new Error("COMPLETED_AT_INVALID");
  }
}

function validateParticipant(row: RecordRow): void {
  if (row.participant_name.trim().length === 0 || row.participant_name.length > 80) {
    throw new Error("PARTICIPANT_NAME_INVALID");
  }
  if (!/^010$/.test(row.phone_part1) || !/^\d{4}$/.test(row.phone_part2) || !/^\d{4}$/.test(row.phone_part3)) throw new Error("PHONE_INVALID");
  if (!/^(?:010\d{8}|010-\d{4}-\d{4})$/.test(row.phone_full)) throw new Error("PHONE_INVALID");
  if (`${row.phone_part1}${row.phone_part2}${row.phone_part3}` !== row.phone_full.replace(/-/g, "")) throw new Error("PHONE_INVALID");
  if (row.privacy_agreed !== "true") throw new Error("CONSENT_REQUIRED");

  const birthdate = calendarDate(row.birthdate);
  if (birthdate == null) throw new Error("BIRTHDATE_INVALID");
  if (
    row.birth_year !== birthdate.year
    || row.birth_month.padStart(2, "0") !== birthdate.month
    || row.birth_day.padStart(2, "0") !== birthdate.day
  ) {
    throw new Error("BIRTHDATE_INVALID");
  }
}

function validateRowSemantics(row: RecordRow): void {
  for (const key of ["is_test", "is_debug", "ai_enabled", "is_admin_edited"] as const) {
    if (row[key] !== "true" && row[key] !== "false") throw new Error("BOOLEAN_INVALID");
  }
  if (row.game_mode !== "ai_challenge" || row.ai_enabled !== "true") throw new Error("AI_MODE_INVALID");
  if ((row.is_debug === "true" && row.debug_mode_type !== "ai_challenge_debug") || (row.is_debug === "false" && row.debug_mode_type !== "")) throw new Error("DEBUG_MODE_INVALID");
  if (row.is_admin_edited !== "false" || row.original_record_id !== "") throw new Error("ADMIN_STATE_INVALID");
  if (row.app_version.trim() === "" || row.app_version.length > 128) throw new Error("APP_VERSION_INVALID");
  if (row.memo.length > 256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.memo)) throw new Error("MEMO_INVALID");

  const charCounts = ([1, 2, 3] as const).map((stage) => integerString(row[`stage${stage}_char_count`], false));
  const totalCharCount = integerString(row.total_char_count, false);
  if (charCounts.reduce((sum, value) => sum + value, 0) !== totalCharCount) throw new Error("CHAR_COUNT_MISMATCH");

  const userTimes = ([1, 2, 3] as const).map((stage) => integerString(row[`stage${stage}_time_ms`], false));
  const stage1Cumulative = integerString(row.stage1_cumulative_ms, false);
  const stage2Cumulative = integerString(row.stage2_cumulative_ms, false);
  const totalTime = integerString(row.total_time_ms, false);
  if (stage1Cumulative !== userTimes[0] || stage2Cumulative !== userTimes[0] + userTimes[1] || totalTime !== userTimes[0] + userTimes[1] + userTimes[2]) throw new Error("USER_TIME_MISMATCH");

  const displayTimes = [row.display_stage1_sec, row.display_stage2_sec, row.display_stage3_sec, row.display_total_sec];
  const expectedDisplayMs = [...userTimes, totalTime];
  displayTimes.forEach((value, index) => {
    const milliseconds = decimalString(value, "ROW_NUMBER_INVALID") * 1000;
    if (!Number.isSafeInteger(Math.round(milliseconds)) || Math.round(milliseconds) !== expectedDisplayMs[index]) throw new Error("DISPLAY_TIME_MISMATCH");
  });

  const finalCpm = integerString(row.final_cpm, false);
  percentString(row.final_accuracy);
  percentString(row.participant_progress_percent);
  percentString(row.ai_progress_percent);
  const participantAvgCpm = optionalIntegerString(row.participant_avg_cpm, false);
  optionalIntegerString(row.ai_avg_cpm, false);

  const aiTimes = ([1, 2, 3] as const).map((stage) => optionalIntegerString(row[`ai_stage${stage}_time_ms`], false));
  const aiTotalTime = integerString(row.ai_total_time_ms, false);
  if (aiTimes.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== aiTotalTime) throw new Error("AI_TIME_MISMATCH");

  const timeDiffs = ([1, 2, 3] as const).map((stage) => optionalIntegerString(row[`stage${stage}_time_diff_ms`], true));
  timeDiffs.forEach((difference, index) => {
    if (aiTimes[index] == null) {
      if (difference != null) throw new Error("TIME_DIFF_MISMATCH");
      return;
    }
    if (difference !== userTimes[index] - aiTimes[index]!) throw new Error("TIME_DIFF_MISMATCH");
  });
  if (integerString(row.final_time_diff_ms, true) !== totalTime - aiTotalTime) throw new Error("TIME_DIFF_MISMATCH");

  const participantResultTime = integerString(row.participant_result_time_ms, false);
  integerString(row.ai_result_time_ms, false);
  const duelTime = integerString(row.duel_time_ms, false);
  if (row.ai_challenge_status === "SUCCESS" && (participantResultTime !== totalTime || duelTime !== totalTime)) {
    throw new Error("RESULT_TIME_MISMATCH");
  }
  const resultStage = rangedStage(row.result_stage, "RESULT_STAGE_INVALID");
  validateAiResultState(row, resultStage, aiTimes);
  if (row.ai_challenge_status === "SUCCESS") {
    const expectedCharCounts = ([1, 2, 3] as const).map((stage) =>
      countTypeableChars(row[`stage${stage}_text`]));
    const expectedCpm = calculateFinalCpm(totalCharCount, totalTime);
    if (
      totalTime === 0
      || userTimes.some((value) => value === 0)
      || charCounts.some((value, index) => value !== expectedCharCounts[index])
      || participantAvgCpm == null
      || finalCpm !== expectedCpm
      || participantAvgCpm !== expectedCpm
    ) {
      throw new Error("SUCCESS_METRICS_INVALID");
    }
  }

  const interruptionMemo = INTERRUPTION_MEMOS.has(row.memo);
  const interruptionLabel = row.challenge_result_label === "중단 패배";
  if (row.memo.startsWith("사용자 중단:") && !interruptionMemo) throw new Error("INTERRUPTION_STATE_INVALID");
  if (interruptionMemo !== interruptionLabel) throw new Error("INTERRUPTION_STATE_INVALID");
  if (interruptionMemo && (row.ai_challenge_status !== "FAILED" || row.final_vs_ai_result !== "AI_WIN" || participantResultTime !== totalTime || duelTime !== totalTime)) throw new Error("INTERRUPTION_STATE_INVALID");
}

function validateAiResultState(row: RecordRow, resultStage: 1 | 2 | 3, aiTimes: readonly (number | null)[]): void {
  const results = [row.stage1_vs_ai_result, row.stage2_vs_ai_result, row.stage3_vs_ai_result];
  const cpms = [row.ai_stage1_cpm, row.ai_stage2_cpm, row.ai_stage3_cpm];
  const diffs = [row.stage1_time_diff_ms, row.stage2_time_diff_ms, row.stage3_time_diff_ms];
  const interrupted = INTERRUPTION_MEMOS.has(row.memo) && row.challenge_result_label === "중단 패배";
  if (row.ai_challenge_status === "SUCCESS") {
    if (row.ai_failed_stage !== "" || resultStage !== 3 || results.some((value) => value !== "USER_WIN") || row.final_vs_ai_result !== "USER_WIN") throw new Error("AI_RESULT_STATE_INVALID");
  } else if (row.ai_challenge_status === "FAILED") {
    const failedStage = rangedStage(row.ai_failed_stage, "AI_RESULT_STATE_INVALID");
    const terminalResult = results[failedStage - 1];
    const completedPopupExit = interrupted && failedStage < 3 && terminalResult === "USER_WIN";
    if (failedStage !== resultStage || row.final_vs_ai_result !== "AI_WIN" || results.slice(0, failedStage - 1).some((value) => value !== "USER_WIN") || (terminalResult !== "AI_WIN" && !completedPopupExit) || results.slice(failedStage).some((value) => value !== "")) throw new Error("AI_RESULT_STATE_INVALID");
  } else {
    throw new Error("AI_RESULT_STATE_INVALID");
  }
  for (let index = 0; index < 3; index += 1) {
    const played = index < resultStage;
    if (played) {
      if (results[index] === "" || cpms[index] === "" || aiTimes[index] == null || diffs[index] === "") throw new Error("AI_RESULT_STATE_INVALID");
    } else if (results[index] !== "" || cpms[index] !== "" || aiTimes[index] != null || diffs[index] !== "") {
      throw new Error("AI_RESULT_STATE_INVALID");
    }
  }
}

function integerString(value: string, signed: boolean, code = "ROW_NUMBER_INVALID"): number {
  const pattern = signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/;
  if (!pattern.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function optionalIntegerString(value: string, signed: boolean): number | null {
  return value === "" ? null : integerString(value, signed);
}

function decimalString(value: string, code: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function percentString(value: string): number {
  const parsed = decimalString(value, "ROW_PERCENT_INVALID");
  if (parsed > 100) throw new Error("ROW_PERCENT_INVALID");
  return parsed;
}

function rangedStage(value: string, code: string): 1 | 2 | 3 {
  const parsed = integerString(value, false, code);
  if (parsed < 1 || parsed > 3) throw new Error(code);
  return parsed as 1 | 2 | 3;
}

function validatePhrases(row: RecordRow, catalog: readonly StageText[]): void {
  for (const stageNumber of [1, 2, 3] as const) {
    const textId = row[`stage${stageNumber}_text_id`];
    const targetText = row[`stage${stageNumber}_text`];
    if (textId === "" && targetText === "") {
      if (row.ai_challenge_status === "SUCCESS") throw new Error("PHRASE_REQUIRED");
      continue;
    }
    const item = catalog.find((candidate) =>
      candidate.id === textId
      && candidate.catalog_version === row.stage_text_catalog_version
      && candidate.game_mode === "ai_challenge"
      && candidate.stage_number === String(stageNumber)
      && candidate.is_active === "true");
    if (item == null || item.text !== targetText) throw new Error("PHRASE_MISMATCH");
  }
}

function validateAiRanges(
  row: RecordRow,
  session: NasSessionV1,
  config: RecordValidationConfigV1,
): void {
  const ranges = config.aiRanges[session.kind];
  for (const stageNumber of [1, 2, 3] as const) {
    const raw = row[`ai_stage${stageNumber}_cpm`];
    if (raw === "") continue;
    const value = integerString(raw, false, "AI_RANGE_INVALID");
    const [minimum, maximum] = ranges[stageNumber - 1];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error("AI_RANGE_INVALID");
    }
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  prefix: string,
): Record<string, unknown> {
  const object = plainObject(value, `${prefix}_INVALID`);
  exactKeys(object, keys, prefix);
  return object;
}

function exactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  prefix: string,
): void {
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`${prefix}_FIELD_MISSING`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${prefix}_UNKNOWN_KEY`);
  }
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
}

function timestamp(value: string, code: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function calendarDate(value: string): { year: string; month: string; day: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match == null) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return { year, month, day };
}
