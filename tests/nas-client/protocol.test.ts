import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceProfile, GeumcheonFairnessInput, RecordRow } from "../../shared/types";
import {
  assertNasLeaderboardSnapshot,
  assertNasRecordAck,
  buildNasRecordEnvelope,
  canonicalStringify,
  createGeumcheonRecordId,
  isGeumcheonRecordId,
  payloadSha256,
} from "../../shared/nas/protocol";

const RECORD_ID = "gsc26-pc10-123e4567-e89b-42d3-a456-426614174000";
const HASH = "1".repeat(64);

const profile: DeviceProfile = {
  schemaVersion: 1,
  eventProfileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC10",
  role: "player",
  apiBaseUrl: "https://example.test",
  sessions: {
    official: { sessionId: "official-1", dayNo: 1, roundNo: 2 },
    practice: { sessionId: "practice-1" },
  },
  requestTimeoutMs: 5_000,
  retry: { initialDelayMs: 2_000, maxDelayMs: 60_000 },
};

const fairness: GeumcheonFairnessInput = {
  catalogVersion: "geumcheon-draft-20260825-v1",
  totalUserTimeMs: 6_000,
  stages: [
    { stageNumber: 1, textId: "gsc26-ai-s1-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "첫 문장", typedText: "첫 문장", userTimeMs: 1_000, typingUnits: 4, aiCpm: 150, result: "USER_WIN" },
    { stageNumber: 2, textId: "gsc26-ai-s2-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "둘째 문장", typedText: "둘째 문장", userTimeMs: 2_000, typingUnits: 5, aiCpm: 200, result: "USER_WIN" },
    { stageNumber: 3, textId: "gsc26-ai-s3-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "셋째 문장", typedText: "셋째 문장", userTimeMs: 3_000, typingUnits: 5, aiCpm: 250, result: "USER_WIN" },
  ],
};

const row = {
  record_id: RECORD_ID,
  created_at: "2026-09-18T01:00:00.000Z",
  completed_at: "2026-09-18T01:01:00.000Z",
  participant_name: "홍길동",
  phone_full: "01012345678",
  birthdate: "2010-01-02",
  privacy_agreed: "true",
  privacy_agreed_at: "2026-09-18T01:00:00.000Z",
  completionStatus: "success",
  app_version: "1.0.0",
  is_test: "false",
  is_debug: "false",
  debug_mode_type: "",
} as RecordRow;

function ack(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    disposition: "stored",
    record_id: RECORD_ID,
    payload_sha256: HASH,
    stored_sha256: "2".repeat(64),
    received_at: "2026-09-18T01:01:01.000Z",
    ...overrides,
  };
}

test("creates only device-scoped UUID v4 record IDs", () => {
  const id = createGeumcheonRecordId("PC10", () => "123e4567-e89b-42d3-a456-426614174000");

  assert.equal(id, RECORD_ID);
  assert.equal(isGeumcheonRecordId(id), true);
  assert.equal(isGeumcheonRecordId("gsc26-pc10-../../record"), false);
});

test("canonicalizes key order while preserving array order", () => {
  assert.equal(canonicalStringify({ b: 2, a: ["first", "second"] }), "{\"a\":[\"first\",\"second\"],\"b\":2}");
  assert.equal(payloadSha256({ b: 2, a: 1 }), payloadSha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalStringify({ value: Number.NaN }));
});

test("rejects an acknowledgement for another payload", () => {
  assert.throws(
    () => assertNasRecordAck(ack({ payload_sha256: "0".repeat(64) }), RECORD_ID, HASH),
    /payload hash/i,
  );
});

test("maps only required local fields into the NAS record envelope", () => {
  assert.deepEqual(buildNasRecordEnvelope(profile, "official", row, fairness), {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
    record: {
      record_id: RECORD_ID,
      created_at: "2026-09-18T01:00:00.000Z",
      completed_at: "2026-09-18T01:01:00.000Z",
      participant: {
        name: "홍길동",
        phone: "01012345678",
        birthdate: "2010-01-02",
        privacy_agreed: true,
        privacy_agreed_at: "2026-09-18T01:00:00.000Z",
      },
      status: "success",
      stages: [
        { stage_no: 1, text_id: "gsc26-ai-s1-001", catalog_version: "geumcheon-draft-20260825-v1", target_text: "첫 문장", typed_text: "첫 문장", user_time_ms: 1_000, ai_cpm: 150, result: "USER_WIN" },
        { stage_no: 2, text_id: "gsc26-ai-s2-001", catalog_version: "geumcheon-draft-20260825-v1", target_text: "둘째 문장", typed_text: "둘째 문장", user_time_ms: 2_000, ai_cpm: 200, result: "USER_WIN" },
        { stage_no: 3, text_id: "gsc26-ai-s3-001", catalog_version: "geumcheon-draft-20260825-v1", target_text: "셋째 문장", typed_text: "셋째 문장", user_time_ms: 3_000, ai_cpm: 250, result: "USER_WIN" },
      ],
      app_version: "1.0.0",
      is_test: false,
      is_debug: false,
      debug_mode_type: "",
    },
  });
});

test("rejects NAS envelopes without fairness data or valid stage timing", () => {
  assert.throws(() => buildNasRecordEnvelope(profile, "official", row, undefined), /fairness/i);
  assert.throws(
    () => buildNasRecordEnvelope(profile, "official", row, { ...fairness, stages: [{ ...fairness.stages[0], userTimeMs: 0 }] }),
    /stage/i,
  );
});

test("rejects public leaderboard snapshots containing raw participant data", () => {
  assert.throws(
    () => assertNasLeaderboardSnapshot({
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
      generated_at: "2026-09-18T01:01:01.000Z",
      entries: [{ rank: 1, record_id: RECORD_ID, display_name: "홍*동", phone_masked: "****5678", display_cpm: 700, total_user_time_ms: 6_000, completed_at: "2026-09-18T01:01:00.000Z", result_stage: 3, attempt_number: 1, phone_full: "01012345678" }],
    }),
    /PUBLIC_SNAPSHOT_INVALID/,
  );
});

test("rejects a leaderboard phone mask containing a raw mobile number", () => {
  assert.throws(
    () => assertNasLeaderboardSnapshot({
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: { kind: "practice", session_id: "practice-1" },
      generated_at: "2026-09-18T01:01:01.000Z",
      entries: [{ rank: 1, record_id: RECORD_ID, display_name: "홍*동", phone_masked: "01012345678", display_cpm: 700, total_user_time_ms: 6_000, completed_at: "2026-09-18T01:01:00.000Z", result_stage: 3, attempt_number: 1 }],
    }),
    /PUBLIC_SNAPSHOT_INVALID/,
  );
});
