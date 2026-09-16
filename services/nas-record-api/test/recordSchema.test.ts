import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedPrincipal } from "../src/auth.js";
import { validateAndNormalizeRecord } from "../src/recordSchema.js";
import { envelope, PRACTICE_SESSION, RECEIVED_AT, recordRow, validationConfig } from "./fixtures.js";

const principal: AuthenticatedPrincipal = {
  tokenId: "PC01-write",
  deviceId: "PC01",
  eventId: "geumcheon-science-festival-2026",
  role: "writer",
  allowedSessions: ["official", "practice"],
};

test("accepts and preserves a complete interrupted RecordRow without fairness metadata", () => {
  const row = recordRow({
    memo: "사용자 중단:프로그램 종료",
    ai_challenge_status: "FAILED",
    ai_failed_stage: "2",
    stage2_vs_ai_result: "AI_WIN",
    stage3_vs_ai_result: "",
    final_vs_ai_result: "AI_WIN",
    challenge_result_label: "중단 패배",
    result_stage: "2",
    phone_full: "010-0000-0001",
    stage1_char_count: "4", stage2_char_count: "2", stage3_char_count: "0", total_char_count: "6",
    stage1_time_ms: "1000", stage2_time_ms: "500", stage3_time_ms: "0",
    stage1_cumulative_ms: "1000", stage2_cumulative_ms: "1500", total_time_ms: "1500",
    display_stage1_sec: "1.000", display_stage2_sec: "0.500", display_stage3_sec: "0.000", display_total_sec: "1.500",
    ai_stage1_time_ms: "1600", ai_stage2_time_ms: "400", ai_stage3_time_ms: "", ai_total_time_ms: "2000",
    ai_stage3_cpm: "",
    stage1_time_diff_ms: "-600", stage2_time_diff_ms: "100", stage3_time_diff_ms: "", final_time_diff_ms: "-500",
    participant_result_time_ms: "1500", ai_result_time_ms: "2000",
    participant_progress_percent: "50", ai_progress_percent: "100", duel_time_ms: "1500",
  });
  const stored = validateAndNormalizeRecord(envelope(row), principal, validationConfig("X:\\data"), RECEIVED_AT);

  assert.deepEqual(stored.row, row);
  assert.equal(stored.row.memo, "사용자 중단:프로그램 종료");
  assert.equal(stored.row.challenge_result_label, "중단 패배");
  assert.equal("record" in stored, false);
  assert.match(stored.payload_sha256, /^[0-9a-f]{64}$/);
});

test("rejects a forged successful record with no registered phrases and impossible metrics", () => {
  const forged = recordRow({
    stage1_text: "",
    stage2_text: "",
    stage3_text: "",
    stage1_text_id: "",
    stage2_text_id: "",
    stage3_text_id: "",
    stage1_char_count: "0",
    stage2_char_count: "0",
    stage3_char_count: "0",
    total_char_count: "0",
    stage1_time_ms: "0",
    stage2_time_ms: "0",
    stage3_time_ms: "0",
    stage1_cumulative_ms: "0",
    stage2_cumulative_ms: "0",
    total_time_ms: "0",
    display_stage1_sec: "0",
    display_stage2_sec: "0",
    display_stage3_sec: "0",
    display_total_sec: "0",
    stage1_time_diff_ms: "-1600",
    stage2_time_diff_ms: "-2400",
    stage3_time_diff_ms: "-3200",
    final_time_diff_ms: "-7200",
    final_cpm: "999999",
    participant_avg_cpm: "999999",
    participant_result_time_ms: "0",
    duel_time_ms: "0",
  });

  assert.throws(
    () => validateAndNormalizeRecord(envelope(forged), principal, validationConfig("X:\\data"), RECEIVED_AT),
    /PHRASE_REQUIRED|SUCCESS_METRICS_INVALID/,
  );
});

test("rejects each forged successful phrase, time, character count, and CPM field independently", () => {
  const cases: ReadonlyArray<{
    name: string;
    overrides: Partial<ReturnType<typeof recordRow>>;
    code: RegExp;
  }> = [
    {
      name: "missing registered stage phrase",
      overrides: { stage2_text: "", stage2_text_id: "" },
      code: /PHRASE_REQUIRED/,
    },
    {
      name: "zero-duration success",
      overrides: {
        stage1_time_ms: "0",
        stage2_time_ms: "0",
        stage3_time_ms: "0",
        stage1_cumulative_ms: "0",
        stage2_cumulative_ms: "0",
        total_time_ms: "0",
        display_stage1_sec: "0",
        display_stage2_sec: "0",
        display_stage3_sec: "0",
        display_total_sec: "0",
        stage1_time_diff_ms: "-1600",
        stage2_time_diff_ms: "-2400",
        stage3_time_diff_ms: "-3200",
        final_time_diff_ms: "-7200",
        final_cpm: "0",
        participant_avg_cpm: "0",
        participant_result_time_ms: "0",
        duel_time_ms: "0",
      },
      code: /SUCCESS_METRICS_INVALID/,
    },
    {
      name: "inflated participant CPM",
      overrides: { final_cpm: "999999", participant_avg_cpm: "999999" },
      code: /SUCCESS_METRICS_INVALID/,
    },
    {
      name: "character counts unrelated to registered phrases",
      overrides: {
        stage1_char_count: "1",
        stage2_char_count: "1",
        stage3_char_count: "1",
        total_char_count: "3",
        final_cpm: "30",
        participant_avg_cpm: "30",
      },
      code: /SUCCESS_METRICS_INVALID/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => validateAndNormalizeRecord(envelope(recordRow(item.overrides)), principal, validationConfig("X:\\data"), RECEIVED_AT),
      item.code,
      item.name,
    );
  }
});

test("accepts an interrupted countdown record with zero typing time and progress", () => {
  const countdown = recordRow({
    memo: "사용자 중단:프로그램 종료",
    ai_challenge_status: "FAILED",
    ai_failed_stage: "1",
    stage1_char_count: "0",
    stage2_char_count: "0",
    stage3_char_count: "0",
    total_char_count: "0",
    stage1_time_ms: "0",
    stage2_time_ms: "0",
    stage3_time_ms: "0",
    stage1_cumulative_ms: "0",
    stage2_cumulative_ms: "0",
    total_time_ms: "0",
    display_stage1_sec: "0",
    display_stage2_sec: "0",
    display_stage3_sec: "0",
    display_total_sec: "0",
    final_cpm: "0",
    ai_stage2_cpm: "",
    ai_stage3_cpm: "",
    ai_stage1_time_ms: "0",
    ai_stage2_time_ms: "",
    ai_stage3_time_ms: "",
    ai_total_time_ms: "0",
    stage1_vs_ai_result: "AI_WIN",
    stage2_vs_ai_result: "",
    stage3_vs_ai_result: "",
    final_vs_ai_result: "AI_WIN",
    stage1_time_diff_ms: "0",
    stage2_time_diff_ms: "",
    stage3_time_diff_ms: "",
    final_time_diff_ms: "0",
    participant_result_time_ms: "0",
    ai_result_time_ms: "0",
    participant_avg_cpm: "0",
    ai_avg_cpm: "150",
    challenge_result_label: "중단 패배",
    participant_progress_percent: "0",
    ai_progress_percent: "100",
    duel_time_ms: "0",
    result_stage: "1",
  });

  assert.equal(
    validateAndNormalizeRecord(envelope(countdown), principal, validationConfig("X:\\data"), RECEIVED_AT).row.total_time_ms,
    "0",
  );
});

test("rejects malformed, out-of-range, and internally inconsistent score fields", () => {
  const cases: ReadonlyArray<{ name: string; overrides: Partial<ReturnType<typeof recordRow>>; code: RegExp }> = [
    { name: "negative total time", overrides: { total_time_ms: "-1" }, code: /ROW_NUMBER_INVALID/ },
    { name: "non numeric stage time", overrides: { stage1_time_ms: "not-a-number" }, code: /ROW_NUMBER_INVALID/ },
    { name: "accuracy over 100", overrides: { final_accuracy: "999" }, code: /ROW_PERCENT_INVALID/ },
    { name: "progress over 100", overrides: { participant_progress_percent: "1000" }, code: /ROW_PERCENT_INVALID/ },
    { name: "result stage outside 1 to 3", overrides: { result_stage: "99" }, code: /RESULT_STAGE_INVALID/ },
    { name: "character total mismatch", overrides: { total_char_count: "999" }, code: /CHAR_COUNT_MISMATCH/ },
    { name: "cumulative time mismatch", overrides: { stage2_cumulative_ms: "999" }, code: /USER_TIME_MISMATCH/ },
    { name: "AI total mismatch", overrides: { ai_total_time_ms: "999" }, code: /AI_TIME_MISMATCH/ },
    { name: "display time mismatch", overrides: { display_total_sec: "99" }, code: /DISPLAY_TIME_MISMATCH/ },
    { name: "stage time difference mismatch", overrides: { stage1_time_diff_ms: "0" }, code: /TIME_DIFF_MISMATCH/ },
    { name: "participant result time mismatch", overrides: { participant_result_time_ms: "1" }, code: /RESULT_TIME_MISMATCH/ },
    { name: "invalid boolean string", overrides: { is_test: "yes" }, code: /BOOLEAN_INVALID/ },
  ];
  for (const item of cases) {
    assert.throws(
      () => validateAndNormalizeRecord(envelope(recordRow(item.overrides)), principal, validationConfig("X:\\data"), RECEIVED_AT),
      item.code,
      item.name,
    );
  }
});

test("rejects AI result state combinations that contradict success or defeat", () => {
  assert.throws(
    () => validateAndNormalizeRecord(
      envelope(recordRow({ ai_challenge_status: "SUCCESS", stage2_vs_ai_result: "AI_WIN" })),
      principal,
      validationConfig("X:\\data"),
      RECEIVED_AT,
    ),
    /AI_RESULT_STATE_INVALID/,
  );
  assert.throws(
    () => validateAndNormalizeRecord(
      envelope(recordRow({ memo: "사용자 중단:프로그램 종료", challenge_result_label: "참가자 승리" })),
      principal,
      validationConfig("X:\\data"),
      RECEIVED_AT,
    ),
    /INTERRUPTION_STATE_INVALID/,
  );
});

test("rejects missing or unknown RecordRow fields instead of accepting reduced snapshots", () => {
  const reduced = envelope(recordRow()) as unknown as { row: Record<string, unknown> };
  delete reduced.row.phone_full;
  assert.throws(() => validateAndNormalizeRecord(reduced, principal, validationConfig("X:\\data"), RECEIVED_AT), /ROW_FIELD_MISSING/);

  const unknown = envelope(recordRow()) as unknown as { row: Record<string, unknown> };
  unknown.row.server_rank = 1;
  assert.throws(() => validateAndNormalizeRecord(unknown, principal, validationConfig("X:\\data"), RECEIVED_AT), /ROW_UNKNOWN_KEY/);
});

test("enforces event, writer device, and configured session scope", () => {
  assert.throws(() => validateAndNormalizeRecord(
    envelope(),
    { ...principal, deviceId: "PC02" },
    validationConfig("X:\\data"),
    RECEIVED_AT,
  ), /DEVICE_MISMATCH/);

  const wrongEvent = envelope() as unknown as { event_id: string };
  wrongEvent.event_id = "other";
  assert.throws(() => validateAndNormalizeRecord(wrongEvent, principal, validationConfig("X:\\data"), RECEIVED_AT), /EVENT_ID_INVALID/);

  const wrongSession = envelope();
  wrongSession.session = { ...wrongSession.session, session_id: "unknown" };
  assert.throws(() => validateAndNormalizeRecord(wrongSession, principal, validationConfig("X:\\data"), RECEIVED_AT), /SESSION_INVALID/);
});

test("preserves official/practice separation and validates each session AI range", () => {
  const practice = envelope(recordRow({
    ai_stage1_cpm: "100",
    ai_stage2_cpm: "125",
    ai_stage3_cpm: "150",
  }), PRACTICE_SESSION);
  assert.equal(validateAndNormalizeRecord(practice, principal, validationConfig("X:\\data"), RECEIVED_AT).session.kind, "practice");

  practice.row.ai_stage1_cpm = "126";
  assert.throws(() => validateAndNormalizeRecord(practice, principal, validationConfig("X:\\data"), RECEIVED_AT), /AI_RANGE_INVALID/);
});

test("validates phrase identity, timestamps, consent, phone and birth date", () => {
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ stage1_text_id: "unknown" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /PHRASE_MISMATCH/);
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ completed_at: "2026-08-26T02:00:00.000Z" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /COMPLETED_AT_INVALID/);
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ privacy_agreed: "false" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /CONSENT_REQUIRED/);
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ phone_full: "010-1234" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /PHONE_INVALID/);
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ birthdate: "2001-02-29" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /BIRTHDATE_INVALID/);
});

test("tolerates a client clock ahead of the server by up to 5 minutes but keeps received_at authoritative", () => {
  // RECEIVED_AT is 03:10:00Z; a rental PC clock 4 minutes ahead must not lose the record.
  const ahead = validateAndNormalizeRecord(envelope(recordRow({ completed_at: "2026-08-26T03:14:00.000Z" })), principal, validationConfig("X:\\data"), RECEIVED_AT);
  assert.equal(ahead.row.completed_at, "2026-08-26T03:14:00.000Z");
  assert.equal(ahead.received_at, RECEIVED_AT);
  // 6 minutes ahead exceeds the tolerance and is still rejected.
  assert.throws(() => validateAndNormalizeRecord(envelope(recordRow({ completed_at: "2026-08-26T03:16:00.000Z" })), principal, validationConfig("X:\\data"), RECEIVED_AT), /COMPLETED_AT_INVALID/);
});

test("rejects payloads whose canonical form exceeds 32 KiB", () => {
  assert.throws(
    () => validateAndNormalizeRecord(envelope(recordRow({ memo: "x".repeat(33 * 1024) })), principal, validationConfig("X:\\data"), RECEIVED_AT),
    /BODY_TOO_LARGE/,
  );
});
