import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { StageText } from "../../../shared/types/index.js";
import type { NasRecordEnvelopeV1 } from "../../../shared/nas/protocol.js";
import { countConvertedTypingUnits } from "../../../shared/utils/typing.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";
import {
  validateAndNormalizeRecord,
  type RecordValidationConfigV1,
} from "../src/recordSchema.js";

const RECEIVED_AT = "2026-08-26T03:10:00.000Z";
const CATALOG_VERSION = "synthetic-catalog-v1";
const HMAC_KEY = Buffer.alloc(32, 31);

const CATALOG: readonly StageText[] = [
  { id: "synthetic-s1", catalog_version: CATALOG_VERSION, game_mode: "ai_challenge", stage_number: "1", text: "가나", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
  { id: "synthetic-s2", catalog_version: CATALOG_VERSION, game_mode: "ai_challenge", stage_number: "2", text: "각1", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
  { id: "synthetic-s3", catalog_version: CATALOG_VERSION, game_mode: "ai_challenge", stage_number: "3", text: "한글!", is_active: "true", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" },
];

function config(): RecordValidationConfigV1 {
  return {
    schemaVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    dataRoot: "X:\\synthetic-data-root",
    recordBaseFolderName: "기록저장",
    stageTextCatalogPath: "X:\\synthetic-stage-texts.csv",
    allowedSessions: {
      official: [{ sessionId: "official-day1-round1", dayNo: 1, roundNo: 1 }],
      practice: { sessionId: "practice-2026" },
    },
    aiRanges: {
      official: [[150, 200], [200, 250], [250, 300]],
      practice: [[100, 150], [150, 200], [200, 250]],
    },
    stageTextCatalog: CATALOG,
    participantHmacKey: HMAC_KEY,
  };
}

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    tokenId: "PC01-write",
    deviceId: "PC01",
    eventId: "geumcheon-science-festival-2026",
    role: "writer",
    allowedSessions: ["official", "practice"],
    ...overrides,
  };
}

function validEnvelope(): NasRecordEnvelopeV1 {
  return {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "official", session_id: "official-day1-round1", day_no: 1, round_no: 1 },
    record: {
      record_id: "gsc26-pc01-11111111-1111-4111-8111-111111111111",
      created_at: "2026-08-26T03:00:00.000Z",
      completed_at: "2026-08-26T03:00:06.000Z",
      participant: {
        name: "테스트참가자",
        phone: "01000000001",
        birthdate: "2000-02-29",
        privacy_agreed: true,
        privacy_agreed_at: "2026-08-26T02:59:59.000Z",
      },
      status: "success",
      stages: [
        { stage_no: 1, text_id: "synthetic-s1", catalog_version: CATALOG_VERSION, target_text: "가나", typed_text: "가나", user_time_ms: 1000, ai_cpm: 150, result: "USER_WIN" },
        { stage_no: 2, text_id: "synthetic-s2", catalog_version: CATALOG_VERSION, target_text: "각1", typed_text: "각1", user_time_ms: 2000, ai_cpm: 200, result: "USER_WIN" },
        { stage_no: 3, text_id: "synthetic-s3", catalog_version: CATALOG_VERSION, target_text: "한글!", typed_text: "한글!", user_time_ms: 3000, ai_cpm: 250, result: "USER_WIN" },
      ],
      app_version: "1.0.0-synthetic",
      is_test: false,
      is_debug: false,
      debug_mode_type: "",
    },
  };
}

function cloneEnvelope(): NasRecordEnvelopeV1 {
  return structuredClone(validEnvelope());
}

test("recalculates all private identity, typing, timing, and exact CPM derivatives server-side", () => {
  const envelope = validEnvelope();
  const stored = validateAndNormalizeRecord(envelope, principal(), config(), RECEIVED_AT);
  assert.equal(stored.record.participant.phone, "010-0000-0001");
  assert.equal(stored.record.participant.phone_masked, "010-****-0001");
  assert.equal(stored.record.participant.birthdate_masked, "2000-**-**");
  assert.equal(
    stored.record.participant_key,
    createHmac("sha256", HMAC_KEY).update("010-0000-0001", "utf8").digest("hex"),
  );
  assert.deepEqual(stored.record.stages.map((stage) => stage.typing_units), [4, 4, 7]);
  assert.equal(stored.record.total_typing_units, 15);
  assert.equal(stored.record.total_typing_units, stored.record.stages.reduce((sum, stage) => sum + countConvertedTypingUnits(stage.typed_text), 0));
  assert.equal(stored.record.total_user_time_ms, 6000);
  assert.equal(stored.record.effective_cpm_numerator, 900_000);
  assert.equal(stored.record.effective_cpm_denominator, 6000);
  assert.equal(stored.record.display_cpm, 150);
  assert.equal(stored.record.authenticated_device_id, "PC01");
  assert.equal(stored.record.received_at, RECEIVED_AT);
  assert.match(stored.payload_sha256, /^[0-9a-f]{64}$/);
});

test("requires exact phrase ID, catalog version, target text, and gapless stage order", () => {
  const wrongId = cloneEnvelope();
  wrongId.record.stages[0]!.text_id = "unknown-s1";
  assert.throws(() => validateAndNormalizeRecord(wrongId, principal(), config(), RECEIVED_AT), /PHRASE_MISMATCH/);

  const wrongVersion = cloneEnvelope();
  wrongVersion.record.stages[0]!.catalog_version = "old-catalog";
  assert.throws(() => validateAndNormalizeRecord(wrongVersion, principal(), config(), RECEIVED_AT), /PHRASE_MISMATCH/);

  const wrongText = cloneEnvelope();
  wrongText.record.stages[0]!.target_text = "다른문구";
  assert.throws(() => validateAndNormalizeRecord(wrongText, principal(), config(), RECEIVED_AT), /PHRASE_MISMATCH/);

  const gap = cloneEnvelope();
  gap.record.stages[1]!.stage_no = 3;
  assert.throws(() => validateAndNormalizeRecord(gap, principal(), config(), RECEIVED_AT), /STAGE_ORDER/);
});

test("validates real calendar dates, Korean mobile numbers, and explicit consent", () => {
  const invalidDate = cloneEnvelope();
  invalidDate.record.participant.birthdate = "2025-02-29";
  assert.throws(() => validateAndNormalizeRecord(invalidDate, principal(), config(), RECEIVED_AT), /BIRTHDATE_INVALID/);

  const invalidPhone = cloneEnvelope();
  invalidPhone.record.participant.phone = "011-0000-0001";
  assert.throws(() => validateAndNormalizeRecord(invalidPhone, principal(), config(), RECEIVED_AT), /PHONE_INVALID/);

  const noConsent = cloneEnvelope();
  noConsent.record.participant.privacy_agreed = false;
  assert.throws(() => validateAndNormalizeRecord(noConsent, principal(), config(), RECEIVED_AT), /CONSENT_REQUIRED/);

  const invalidTimestamp = cloneEnvelope();
  invalidTimestamp.record.completed_at = "2025-02-29T03:00:06.000Z";
  assert.throws(() => validateAndNormalizeRecord(invalidTimestamp, principal(), config(), RECEIVED_AT), /COMPLETED_AT_INVALID/);
});

test("keeps official and practice session and AI ranges exact and separate", () => {
  const officialTooSlow = cloneEnvelope();
  officialTooSlow.record.stages[0]!.ai_cpm = 149;
  assert.throws(() => validateAndNormalizeRecord(officialTooSlow, principal(), config(), RECEIVED_AT), /AI_RANGE/);

  const practice = cloneEnvelope();
  practice.session = { kind: "practice", session_id: "practice-2026" };
  practice.record.stages[0]!.ai_cpm = 100;
  practice.record.stages[1]!.ai_cpm = 150;
  practice.record.stages[2]!.ai_cpm = 200;
  assert.equal(validateAndNormalizeRecord(practice, principal(), config(), RECEIVED_AT).session.kind, "practice");

  practice.record.stages[0]!.ai_cpm = 151;
  assert.throws(() => validateAndNormalizeRecord(practice, principal(), config(), RECEIVED_AT), /AI_RANGE/);

  assert.throws(
    () => validateAndNormalizeRecord(validEnvelope(), principal({ allowedSessions: ["practice"] }), config(), RECEIVED_AT),
    /SESSION_SCOPE/,
  );
});

test("requires finite positive timing, exact typed prefixes, and status agreement", () => {
  const invalidTime = cloneEnvelope();
  invalidTime.record.stages[0]!.user_time_ms = Number.NaN;
  assert.throws(() => validateAndNormalizeRecord(invalidTime, principal(), config(), RECEIVED_AT), /BODY_INVALID|TIME_INVALID/);

  const notPrefix = cloneEnvelope();
  notPrefix.record.stages[0]!.typed_text = "나다";
  assert.throws(() => validateAndNormalizeRecord(notPrefix, principal(), config(), RECEIVED_AT), /TYPED_PREFIX/);

  const shortSuccess = cloneEnvelope();
  shortSuccess.record.stages = shortSuccess.record.stages.slice(0, 2);
  assert.throws(() => validateAndNormalizeRecord(shortSuccess, principal(), config(), RECEIVED_AT), /STATUS_MISMATCH/);

  const failed = cloneEnvelope();
  failed.record.status = "failed";
  failed.record.stages = [{ ...failed.record.stages[0]!, typed_text: "가", result: "AI_WIN" }];
  const stored = validateAndNormalizeRecord(failed, principal(), config(), RECEIVED_AT);
  assert.equal(stored.record.status, "failed");
  assert.equal(stored.record.total_typing_units, 2);
});

test("rejects client derivatives, unknown fields, and canonical bodies above 32 KiB", () => {
  const derivative = cloneEnvelope() as unknown as Record<string, unknown>;
  (derivative.record as Record<string, unknown>).total_typing_units = 999_999;
  assert.throws(() => validateAndNormalizeRecord(derivative, principal(), config(), RECEIVED_AT), /UNKNOWN_KEY/);

  const oversized = cloneEnvelope();
  oversized.record.app_version = "x".repeat(33 * 1024);
  assert.throws(() => validateAndNormalizeRecord(oversized, principal(), config(), RECEIVED_AT), /BODY_TOO_LARGE/);
});

test("binds record identity and writer authority to the authenticated device", () => {
  assert.throws(
    () => validateAndNormalizeRecord(validEnvelope(), principal({ deviceId: "PC02" }), config(), RECEIVED_AT),
    /DEVICE_SCOPE/,
  );
  assert.throws(
    () => validateAndNormalizeRecord(validEnvelope(), principal({ role: "leaderboard" }), config(), RECEIVED_AT),
    /ROLE_SCOPE/,
  );
});
