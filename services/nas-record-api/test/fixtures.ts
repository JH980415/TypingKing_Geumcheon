import { createHash } from "node:crypto";

import { RECORD_HEADERS } from "../../../shared/constants/defaults.js";
import type { NasRecordEnvelopeV1, NasSessionV1 } from "../../../shared/nas/protocol.js";
import type { RecordRow, StageText } from "../../../shared/types/index.js";
import { buildCanonicalAiAttempt } from "../../../shared/utils/geumcheonAiAttempt.js";
import type { TokenManifestV1 } from "../src/auth.js";
import type { RecordValidationConfigV1 } from "../src/recordSchema.js";

export const RECEIVED_AT = "2026-08-26T03:10:00.000Z";
export const RECORD_ID = "gsc26-pc01-11111111-1111-4111-8111-111111111111";
export const TOKENS = {
  writer: "1".repeat(64),
  leaderboard: "2".repeat(64),
  operator: "3".repeat(64),
} as const;

export const OFFICIAL_SESSION: NasSessionV1 = {
  kind: "official",
  session_id: "official-day1-round1",
  day_no: 1,
  round_no: 1,
};
export const PRACTICE_SESSION: NasSessionV1 = {
  kind: "practice",
  session_id: "practice-2026",
};

export const CATALOG: readonly StageText[] = [
  { id: "s1", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "1", text: "첫 문장", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
  { id: "s2", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "2", text: "둘 문장", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
  { id: "s3", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "3", text: "셋 문장", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
];

export function recordRow(overrides: Partial<RecordRow> = {}): RecordRow {
  const row = Object.fromEntries(RECORD_HEADERS.map((key) => [key, ""])) as unknown as RecordRow;
  const completed = Object.assign(row, {
    record_id: RECORD_ID,
    created_at: "2026-08-26T03:00:00.000Z",
    completed_at: "2026-08-26T03:00:06.000Z",
    participant_name: "합성참가자",
    phone_part1: "010",
    phone_part2: "0000",
    phone_part3: "0001",
    phone_full: "01000000001",
    phone_masked: "010-****-0001",
    birth_year: "2000",
    birth_month: "02",
    birth_day: "29",
    birthdate: "2000-02-29",
    birthdate_masked: "2000-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: "2026-08-26T02:59:59.000Z",
    stage1_text: "첫 문장",
    stage2_text: "둘 문장",
    stage3_text: "셋 문장",
    stage_text_catalog_version: "v1",
    stage1_text_id: "s1",
    stage2_text_id: "s2",
    stage3_text_id: "s3",
    stage1_char_count: "4",
    stage2_char_count: "4",
    stage3_char_count: "4",
    total_char_count: "12",
    stage1_time_ms: "1000",
    stage2_time_ms: "2000",
    stage3_time_ms: "3000",
    stage1_cumulative_ms: "1000",
    stage2_cumulative_ms: "3000",
    total_time_ms: "6000",
    display_stage1_sec: "1.0",
    display_stage2_sec: "2.0",
    display_stage3_sec: "3.0",
    display_total_sec: "6.0",
    final_cpm: "120",
    final_accuracy: "100",
    app_version: "1.0.0-test",
    is_test: "false",
    is_debug: "false",
    debug_mode_type: "",
    memo: "",
    game_mode: "ai_challenge",
    ai_enabled: "true",
    ai_challenge_status: "SUCCESS",
    ai_failed_stage: "",
    ai_stage1_cpm: "100",
    ai_stage2_cpm: "125",
    ai_stage3_cpm: "150",
    ai_stage1_time_ms: "1600",
    ai_stage2_time_ms: "2400",
    ai_stage3_time_ms: "3200",
    ai_total_time_ms: "7200",
    stage1_vs_ai_result: "USER_WIN",
    stage2_vs_ai_result: "USER_WIN",
    stage3_vs_ai_result: "USER_WIN",
    final_vs_ai_result: "USER_WIN",
    stage1_time_diff_ms: "-600",
    stage2_time_diff_ms: "-400",
    stage3_time_diff_ms: "-200",
    final_time_diff_ms: "-1200",
    participant_result_time_ms: "6000",
    ai_result_time_ms: "7200",
    participant_avg_cpm: "120",
    ai_avg_cpm: "100",
    challenge_result_label: "참가자 승리",
    participant_progress_percent: "100",
    ai_progress_percent: "100",
    duel_time_ms: "6000",
    result_stage: "3",
    original_record_id: "",
    is_admin_edited: "false",
    ...overrides,
  });
  if (completed.canonicalAttempt === undefined) {
    completed.canonicalAttempt = canonicalAttemptForRecord(completed.record_id);
  }
  return completed;
}

function canonicalAttemptForRecord(recordId: string) {
  const identity = /^gsc26-(pc(?:0[1-9]|10))-(.+)$/.exec(recordId);
  return buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: identity == null ? "gsc26-attempt-11111111-1111-4111-8111-111111111111" : `gsc26-attempt-${identity[2]}`,
    recordId,
    deviceId: identity == null ? "PC01" : identity[1]!.toUpperCase(),
    recordedAt: "2026-08-26T03:00:06.000Z",
    result: "PARTICIPANT_WIN",
    interruptionReason: null,
    participantFinishTimeMs: 6000,
    geumnaraeFinishTimeMs: 7200,
    stages: [
      { stageNumber: 1, entered: true, assignedInputUnits: 1, participantCorrectInputUnits: 1, participantValidInputUnits: 1, participantActiveTypingTimeMs: 2000, geumnaraeCorrectInputUnits: 1, geumnaraeValidInputUnits: 1, geumnaraeActiveTypingTimeMs: 2400, activeDuelTimeMs: 2000 },
      { stageNumber: 2, entered: true, assignedInputUnits: 1, participantCorrectInputUnits: 1, participantValidInputUnits: 1, participantActiveTypingTimeMs: 2000, geumnaraeCorrectInputUnits: 1, geumnaraeValidInputUnits: 1, geumnaraeActiveTypingTimeMs: 2400, activeDuelTimeMs: 2000 },
      { stageNumber: 3, entered: true, assignedInputUnits: 1, participantCorrectInputUnits: 1, participantValidInputUnits: 1, participantActiveTypingTimeMs: 2000, geumnaraeCorrectInputUnits: 1, geumnaraeValidInputUnits: 1, geumnaraeActiveTypingTimeMs: 2400, activeDuelTimeMs: 2000 },
    ],
  });
}
export function envelope(row = recordRow(), session: NasSessionV1 = OFFICIAL_SESSION): NasRecordEnvelopeV1 {
  return {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session,
    row,
  };
}

export function validationConfig(dataRoot: string): RecordValidationConfigV1 {
  return {
    schemaVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    dataRoot,
    recordBaseFolderName: "기록저장",
    stageTextCatalogPath: "X:\\synthetic-stage-texts.csv",
    allowedSessions: {
      official: [{ sessionId: "official-day1-round1", dayNo: 1, roundNo: 1 }],
      practice: { sessionId: "practice-2026" },
    },
    aiRanges: {
      official: [[100, 125], [125, 150], [150, 200]],
      practice: [[100, 125], [125, 150], [150, 200]],
    },
    stageTextCatalog: CATALOG,
    participantHmacKey: Buffer.alloc(32, 7),
  };
}

export function tokenManifest(): TokenManifestV1 {
  return {
    manifestVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    tokens: [
      tokenEntry("writer", "PC01-write", "PC01", TOKENS.writer),
      tokenEntry("leaderboard", "leaderboard", "LEADERBOARD01", TOKENS.leaderboard),
      tokenEntry("operator", "operator", "OPERATOR01", TOKENS.operator),
    ],
  };
}

function tokenEntry(
  role: "writer" | "leaderboard" | "operator",
  tokenId: string,
  deviceId: string,
  token: string,
): TokenManifestV1["tokens"][number] {
  return {
    tokenId,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    deviceId,
    role,
    allowedSessions: ["official", "practice"],
    expiresAt: "2026-09-30T00:00:00.000Z",
    revokedAt: null,
  };
}

export function headers(role: keyof typeof TOKENS, extra: Record<string, string> = {}): Record<string, string> {
  const deviceId = role === "writer" ? "PC01" : role === "leaderboard" ? "LEADERBOARD01" : "OPERATOR01";
  return {
    authorization: `Bearer ${TOKENS[role]}`,
    "x-device-id": deviceId,
    "content-type": "application/json",
    ...extra,
  };
}
