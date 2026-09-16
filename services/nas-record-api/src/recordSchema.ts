import { RECORD_HEADERS } from "../../../shared/constants/defaults.js";
import type { NasRecordEnvelopeV1, NasSessionV1 } from "../../../shared/nas/protocol.js";
import {
  GEUMCHEON_NAS_EVENT_ID,
  canonicalStringify,
  isPairedGeumcheonAttemptIdentity,
  isGeumcheonRecordId,
  payloadSha256,
} from "../../../shared/nas/protocol.js";
import type {
  CanonicalAiContradictionCode,
  RecordRow,
  StageText,
} from "../../../shared/types/index.js";
import {
  buildCanonicalAiAttempt,
  canonicalAiContradictionCodes,
  isCanonicalAiAttemptV1,
} from "../../../shared/utils/geumcheonAiAttempt.js";
import { calculateAccuracy, calculateCurrentCpm, calculateFinalCpm, countConvertedTypingUnits, countMatchingPrefixTypingUnits, countTypeableChars, getTextPrefixByTypingUnits, isExactMatch } from "../../../shared/utils/typing.js";
import { isGeumcheonRecordEvidenceV1 } from "../../../shared/utils/geumcheonRecordEvidence.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import type { NasServerConfigV1 } from "./config.js";

const MAX_CANONICAL_BODY_BYTES = 32 * 1024;
// Rental PC clocks may run ahead of the NAS clock; receivedAt stays the authoritative server timestamp.
const CLIENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
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
  "canonicalAttempt",
  "recordEvidence",
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

export class RecordContradictionError extends Error {
  constructor(
    readonly record: StoredNasRecordV1,
    readonly reasonCodes: readonly CanonicalAiContradictionCode[],
  ) {
    super("RECORD_QUARANTINED");
    this.name = "RecordContradictionError";
  }
}

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
  const evidenceSemantics = Object.hasOwn(row, "recordEvidence")
    ? validateRecordEvidence(row, principal, session, config)
    : undefined;
  validateRowSemantics(row, evidenceSemantics);
  if (!evidenceSemantics) validateAiRanges(row, session, config);

  const normalizedEnvelope: NasRecordEnvelopeV1 = {
    schema_version: 1,
    event_id: GEUMCHEON_NAS_EVENT_ID,
    session,
    row,
  };
  const stored: StoredNasRecordV1 = {
    ...normalizedEnvelope,
    payload_sha256: payloadSha256(normalizedEnvelope),
    authenticated_device_id: principal.deviceId,
    received_at: receivedAt,
  };
  const attempt = row.recordEvidence?.canonicalAttempt ?? row.canonicalAttempt;
  if (attempt === undefined) throw new Error("invalid record");
  if (!isCanonicalAiAttemptV1(attempt)) {
    throw new Error("CANONICAL_ATTEMPT_INVALID");
  }
  const reasonCodes = canonicalAiContradictionCodes(attempt, {
    recordId: row.record_id,
    deviceId: principal.deviceId,
  });
  if (
    !isPairedGeumcheonAttemptIdentity(row.record_id, attempt.attemptId)
    && !reasonCodes.includes("IDENTITY_MISMATCH")
  ) {
    reasonCodes.push("IDENTITY_MISMATCH");
  }
  if (reasonCodes.length > 0) {
    throw new RecordContradictionError(stored, reasonCodes);
  }
  return stored;
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
    if (config.allowedSessions.practice === undefined || session.session_id !== config.allowedSessions.practice.sessionId) {
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
  if (created > completed || completed > received + CLIENT_CLOCK_SKEW_TOLERANCE_MS || consent > completed) {
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

type EvidenceSemantics = { aiTotal: number; differences: readonly number[]; finalDifference: number; participantResultTime: number | null; successCpm: number };

function validateRecordEvidence(row: RecordRow, principal: AuthenticatedPrincipal, session: NasSessionV1, config: RecordValidationConfigV1): EvidenceSemantics {
  const evidence = row.recordEvidence;
  if (!isGeumcheonRecordEvidenceV1(evidence) || row.canonicalAttempt !== undefined) throw new Error("RECORD_EVIDENCE_INVALID");
  exactKeys(row as unknown as Record<string, unknown>, [...RECORD_HEADERS, "fairness", "recordEvidence"], "ROW");
  const { battles, canonicalAttempt: attempt } = evidence;
  const interrupted = INTERRUPTION_MEMOS.has(row.memo);
  const stageReached = rangedStage(row.result_stage, "RESULT_STAGE_INVALID");
  const fail = (): never => { throw new Error("RECORD_EVIDENCE_MISMATCH"); };
  const equal = (actual: unknown, expected: unknown): void => { if (canonicalStringify(actual) !== canonicalStringify(expected)) fail(); };
  const rounded = (value: number | null): string => value === null ? "" : String(Math.round(value));
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
  if (battles.length !== stageReached || battles.some((battle, index) => battle.stage !== index + 1)) fail();
  if (timestamp(attempt.recordedAt, "RECORD_EVIDENCE_INVALID") > timestamp(row.completed_at, "COMPLETED_AT_INVALID")) fail();
  const ranges = config.aiRanges[session.kind];
  for (const battle of battles) {
    const stage = battle.stage as 1 | 2 | 3;
    const target = row[`stage${stage}_text`];
    const assigned = countConvertedTypingUnits(target);
    const terminalInterruption = interrupted && stage === stageReached && battle.result !== "USER_WIN";
    equal(battle.text, target);
    if (!Number.isSafeInteger(battle.userTimeMs) || battle.userTimeMs < 0 || battle.aiTypedUnits > assigned) fail();
    if (battle.entered === false && (!terminalInterruption || battle.userTimeMs !== 0 || battle.userInput !== "" || battle.aiTypedUnits !== 0)) fail();
    const [minimum, maximum] = ranges[stage - 1];
    if (!Number.isInteger(battle.plannedAiCpm) || battle.plannedAiCpm < minimum || battle.plannedAiCpm > maximum) throw new Error("AI_RANGE_INVALID");
    equal(battle.userCpm, calculateCurrentCpm(battle.userInput, battle.userTimeMs, target));
    equal(battle.userAccuracy, calculateAccuracy(battle.userInput, target));
    equal(battle.aiTypedChars, countTypeableChars(getTextPrefixByTypingUnits(target, battle.aiTypedUnits)));
    equal(battle.aiCpm, terminalInterruption ? battle.plannedAiCpm : calculateFinalCpm(battle.aiTypedUnits, battle.aiElapsedMs));
    if (terminalInterruption) {
      equal(battle.aiTimeMs, battle.userTimeMs);
      equal(battle.aiElapsedMs, battle.userTimeMs);
    } else if (battle.result === "USER_WIN") {
      if (!isExactMatch(battle.userInput, target) || battle.userAccuracy !== 100 || battle.userTimeMs > battle.aiTimeMs) fail();
      equal(battle.aiElapsedMs, battle.userTimeMs);
    } else {
      equal(battle.aiElapsedMs, battle.aiTimeMs);
      equal(battle.aiTypedUnits, assigned);
      // Timer loss is decided on the raw clock, then participant time is rounded.
      // Monotonic rounding gives this exact integer bound, without an epsilon.
      if (battle.userTimeMs < Math.round(battle.aiTimeMs)) fail();
    }
    equal(row[`stage${stage}_time_ms`], rounded(battle.userTimeMs));
    equal(row[`ai_stage${stage}_time_ms`], rounded(battle.aiTimeMs));
    equal(row[`ai_stage${stage}_cpm`], String(battle.aiCpm));
    equal(row[`stage${stage}_vs_ai_result`], battle.result);
  }
  const expectedStages = ([1, 2, 3] as const).map((stageNumber) => {
    const battle = battles.find((b) => b.stage === stageNumber);
    const assignedInputUnits = countConvertedTypingUnits(row[`stage${stageNumber}_text`]);
    if (!battle || battle.entered === false) return { stageNumber, entered: false, assignedInputUnits, participantCorrectInputUnits: 0, participantValidInputUnits: 0, participantActiveTypingTimeMs: 0, geumnaraeCorrectInputUnits: 0, geumnaraeValidInputUnits: 0, geumnaraeActiveTypingTimeMs: 0, activeDuelTimeMs: 0 };
    const aiUnits = countConvertedTypingUnits(getTextPrefixByTypingUnits(battle.text, battle.aiTypedUnits));
    return { stageNumber, entered: true, assignedInputUnits, participantCorrectInputUnits: countMatchingPrefixTypingUnits(battle.userInput, battle.text), participantValidInputUnits: countConvertedTypingUnits(battle.userInput), participantActiveTypingTimeMs: Math.round(battle.userTimeMs), geumnaraeCorrectInputUnits: aiUnits, geumnaraeValidInputUnits: aiUnits, geumnaraeActiveTypingTimeMs: Math.round(battle.aiElapsedMs), activeDuelTimeMs: Math.round(battle.aiElapsedMs) };
  });
  const enteredBattles = battles.filter((b) => b.entered !== false);
  const terminal = enteredBattles.at(-1);
  const participantCompleted = row.ai_challenge_status === "SUCCESS" && !interrupted;
  const aiCompleted = terminal != null && terminal.aiTypedUnits >= countConvertedTypingUnits(terminal.text);
  const interruptionReason = !interrupted ? null : row.memo === "사용자 중단:메인화면" ? "HOME" : row.memo === "사용자 중단:다시하기" ? "RETRY" : "EXIT";
  const expectedAttempt = buildCanonicalAiAttempt({ schemaVersion: 1, attemptId: attempt.attemptId, recordId: row.record_id, deviceId: principal.deviceId, recordedAt: attempt.recordedAt, result: interrupted ? "INTERRUPTED" : participantCompleted ? "PARTICIPANT_WIN" : "GEUMNARAE_WIN", interruptionReason, participantFinishTimeMs: participantCompleted ? sum(enteredBattles.map((b) => Math.round(b.userTimeMs))) : null, geumnaraeFinishTimeMs: aiCompleted ? sum(enteredBattles.map((b) => Math.round(b.aiElapsedMs))) : null, stages: expectedStages });
  // Identity and supplied contradiction codes are handled by the existing authoritative
  // contradiction/quarantine path below; never rewrite the protected submitted identity.
  const { attemptId: _claimedAttemptId, recordId: _claimedRecordId, deviceId: _claimedDeviceId, contradictionCodes: _claimedCodes, ...observedMetrics } = attempt;
  const { attemptId: _expectedAttemptId, recordId: _expectedRecordId, deviceId: _expectedDeviceId, contradictionCodes: _expectedCodes, ...expectedMetrics } = expectedAttempt;
  // Intrinsically contradictory canonical evidence must reach durable quarantine.
  // Self-consistent evidence must additionally match the raw source projection.
  if (canonicalAiContradictionCodes(attempt).length === 0) equal(observedMetrics, expectedMetrics);
  const userTotal = sum(battles.map((b) => b.userTimeMs));
  equal(row.total_time_ms, rounded(userTotal));
  for (const stage of [1, 2, 3] as const) {
    equal(row[`stage${stage}_time_ms`], rounded(battles.find((b) => b.stage === stage)?.userTimeMs ?? 0));
  }
  equal(row.fairness, { catalogVersion: row.stage_text_catalog_version, totalUserTimeMs: userTotal, stages: battles.map((b) => ({ stageNumber: b.stage, textId: row[`stage${b.stage as 1 | 2 | 3}_text_id`], catalogVersion: row.stage_text_catalog_version, targetText: b.text, typedText: b.userInput, userTimeMs: b.userTimeMs, typingUnits: countConvertedTypingUnits(b.userInput), aiCpm: b.plannedAiCpm, result: interrupted && b.stage === stageReached && b.result !== "USER_WIN" ? "INTERRUPTED" : b.result })) });
  const participantUnits = sum(battles.map((b) => b.result === "USER_WIN" ? countConvertedTypingUnits(b.text) : countMatchingPrefixTypingUnits(b.userInput, b.text)));
  const aiUnits = sum(battles.map((b) => b.result === "AI_WIN" && !interrupted ? countConvertedTypingUnits(b.text) : Math.min(countConvertedTypingUnits(b.text), b.aiTypedUnits)));
  const aiElapsed = sum(battles.map((b) => b.aiElapsedMs));
  const averagePositive = (values: readonly number[]): number | null => { const positive = values.filter((v) => v > 0); return positive.length ? sum(positive) / positive.length : null; };
  const participantCpm = userTotal > 0 ? Math.round((participantUnits / userTotal) * 60000) : averagePositive(battles.map((b) => b.userCpm));
  const aiCpm = aiElapsed > 0 ? Math.round((aiUnits / aiElapsed) * 60000) : averagePositive(battles.map((b) => b.aiCpm));
  const resultTimes = battles.map((b) => !interrupted && row.ai_challenge_status === "FAILED" && b.stage === stageReached && b.result === "AI_WIN" ? (b.userCpm > 0 ? (countConvertedTypingUnits(b.text) / b.userCpm) * 60000 : null) : b.userTimeMs);
  const participantResult = resultTimes.some((v) => v === null) ? null : sum(resultTimes as number[]);
  const progress = (ai: boolean): number => Math.round(sum(battles.map((b) => {
    const size = countTypeableChars(b.text);
    if (ai) return b.result === "AI_WIN" && !interrupted ? 100 : size > 0 ? Math.min(100, Math.min(size, b.aiTypedChars) / size * 100) : 0;
    return b.result === "USER_WIN" ? 100 : size > 0 ? Math.min(100, countTypeableChars(b.userInput) / size * 100) : 100;
  })) / 3 * 10) / 10;
  equal(row.participant_avg_cpm, rounded(participantCpm));
  equal(row.ai_avg_cpm, rounded(aiCpm));
  equal(row.participant_result_time_ms, rounded(participantResult));
  equal(row.ai_result_time_ms, rounded(aiElapsed));
  equal(row.duel_time_ms, rounded(sum(battles.map((b) => b.result === "AI_WIN" && !interrupted ? b.aiTimeMs : b.userTimeMs))));
  equal(row.participant_progress_percent, String(participantCompleted ? 100 : progress(false)));
  equal(row.ai_progress_percent, String(row.ai_challenge_status === "FAILED" && !interrupted ? 100 : progress(true)));
  equal(row.final_accuracy, String(participantCompleted ? 100 : Math.round(battles.at(-1)!.userAccuracy)));
  equal(row.challenge_result_label, participantCompleted ? "참여자 승리" : interrupted ? "중단 패배" : "금나래 승리");
  const totalUnits = interrupted ? participantUnits : sum(([1, 2, 3] as const).map((n) => countConvertedTypingUnits(row[`stage${n}_text`])));
  const expectedFinalCpm = participantCpm === null ? calculateFinalCpm(totalUnits, userTotal) : Math.round(participantCpm);
  equal(row.final_cpm, String(expectedFinalCpm));
  for (const stage of [1, 2, 3] as const) {
    const battle = battles.find((b) => b.stage === stage);
    equal(row[`stage${stage}_char_count`], String(interrupted ? battle ? countTypeableChars(battle.result === "USER_WIN" ? battle.text : battle.userInput) : 0 : countTypeableChars(row[`stage${stage}_text`])));
  }
  return { aiTotal: Math.round(sum(battles.map((b) => b.aiTimeMs))), differences: battles.map((b) => Math.round(b.userTimeMs - b.aiTimeMs)), finalDifference: Math.round(userTotal - sum(battles.map((b) => b.aiTimeMs))), participantResultTime: participantResult, successCpm: expectedFinalCpm };
}

function validateRowSemantics(row: RecordRow, evidence?: EvidenceSemantics): void {
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
  if ((evidence?.aiTotal ?? aiTimes.reduce<number>((sum, value) => sum + (value ?? 0), 0)) !== aiTotalTime) throw new Error("AI_TIME_MISMATCH");

  const timeDiffs = ([1, 2, 3] as const).map((stage) => optionalIntegerString(row[`stage${stage}_time_diff_ms`], true));
  timeDiffs.forEach((difference, index) => {
    if (aiTimes[index] == null) {
      if (difference != null) throw new Error("TIME_DIFF_MISMATCH");
      return;
    }
    if (difference !== (evidence ? evidence.differences[index] : userTimes[index] - aiTimes[index]!)) throw new Error("TIME_DIFF_MISMATCH");
  });
  if (integerString(row.final_time_diff_ms, true) !== (evidence?.finalDifference ?? totalTime - aiTotalTime)) throw new Error("TIME_DIFF_MISMATCH");

  const participantResultTime = evidence?.participantResultTime === null
    ? optionalIntegerString(row.participant_result_time_ms, false)
    : integerString(row.participant_result_time_ms, false);
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
    const expectedCpm = evidence?.successCpm ?? calculateFinalCpm(totalCharCount, totalTime);
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
