import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceProfile, RecordRow } from "../../shared/types";
import {
  assertNasLeaderboardSnapshot,
  assertNasRecordAck,
  buildNasRecordEnvelope,
  canonicalStringify,
  createGeumcheonAttemptIdentity,
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

const row = {
  record_id: RECORD_ID,
  created_at: "2026-09-18T01:00:00.000Z",
  completed_at: "2026-09-18T01:01:00.000Z",
  participant_name: "홍길동",
  phone_full: "01012345678",
  memo: "사용자 중단:프로그램 종료",
  game_mode: "ai_challenge",
  challenge_result_label: "중단 패배",
} as RecordRow;

function acknowledgement() {
  return {
    schema_version: 1,
    disposition: "stored",
    record_id: RECORD_ID,
    payload_sha256: HASH,
    stored_sha256: "2".repeat(64),
    received_at: "2026-09-18T01:01:01.000Z",
  };
}

test("creates device-scoped UUID record IDs", () => {
  const id = createGeumcheonRecordId("PC10", () => "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(id, RECORD_ID);
  assert.equal(isGeumcheonRecordId(id), true);
  assert.equal(isGeumcheonRecordId("gsc26-pc10-../../record"), false);
});

test("derives one attempt ID and record ID from the same UUID", () => {
  const identity = createGeumcheonAttemptIdentity(
    "PC10",
    () => "123e4567-e89b-42d3-a456-426614174000",
  );

  assert.deepEqual(identity, {
    attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    recordId: "gsc26-pc10-123e4567-e89b-42d3-a456-426614174000",
  });
});

test("canonical JSON and payload hashes do not depend on object insertion order", () => {
  assert.equal(canonicalStringify({ b: 2, a: ["first", "second"] }), '{"a":["first","second"],"b":2}');
  assert.equal(payloadSha256({ b: 2, a: 1 }), payloadSha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalStringify({ invalid: Number.NaN }), /finite/i);
});

test("builds a full RecordRow envelope without fairness or reduced record fields", () => {
  const envelope = buildNasRecordEnvelope(profile, "official", row);

  assert.deepEqual(envelope, {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
    row,
  });
  assert.equal("record" in envelope, false);
});

test("rejects wrong event, device role, and record/device mismatch", () => {
  assert.throws(() => buildNasRecordEnvelope({ ...profile, eventId: "other" }, "official", row), /EVENT_ID/);
  assert.throws(() => buildNasRecordEnvelope({ ...profile, role: "leaderboard" }, "official", row), /DEVICE_ROLE/);
  assert.throws(() => buildNasRecordEnvelope({ ...profile, deviceId: "PC09" }, "official", row), /DEVICE_MISMATCH/);
});

test("official-only envelopes work and missing practice fails explicitly", () => {
  const officialOnly = { ...profile, sessions: { official: profile.sessions.official } } as DeviceProfile;
  assert.deepEqual(buildNasRecordEnvelope(officialOnly, "official", row).session, { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 });
  assert.throws(() => buildNasRecordEnvelope(officialOnly, "practice", row), /^Error: NAS_PRACTICE_SESSION_NOT_CONFIGURED$/);
  assert.deepEqual(buildNasRecordEnvelope(profile, "practice", row).session, { kind: "practice", session_id: "practice-1" });
});

test("validates ACK against both record ID and submitted payload hash", () => {
  assert.doesNotThrow(() => assertNasRecordAck(acknowledgement(), RECORD_ID, HASH));
  assert.throws(() => assertNasRecordAck(acknowledgement(), RECORD_ID, "0".repeat(64)), /payload/i);
});

test("accepts authenticated leaderboard snapshots containing full raw RecordRow rows", () => {
  const snapshot = {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
    generated_at: "2026-09-18T01:02:00.000Z",
    rows: [row],
  };

  assert.doesNotThrow(() => assertNasLeaderboardSnapshot(snapshot));
  assert.equal(snapshot.rows[0]?.phone_full, "01012345678");
});

test("rejects legacy masked/ranked leaderboard entries", () => {
  assert.throws(() => assertNasLeaderboardSnapshot({
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "practice", session_id: "practice-1" },
    generated_at: "2026-09-18T01:02:00.000Z",
    rows: [{ rank: 1, display_name: "홍*동", phone_masked: "010-****-5678" }],
  }), /ROW/);
});
