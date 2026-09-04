import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DeviceProfile } from "../../shared/events/types";
import type { RecordRow, ReviewRuntimeContext, SaveRecordInput } from "../../shared/types";
import type { ActiveAttemptEncryption } from "../../electron/activeAttemptStore";
import { buildRecordRow } from "../../shared/csv/fileStore";
import {
  createReviewGeumcheonConnection,
  initializeGeumcheonConnection,
  listGeumcheonRecords,
  validateReviewStorage
} from "../../electron/geumcheonConnection";
import { createReviewLocalRuntime } from "../../electron/review/reviewLocalRuntime";

const reviewContext: ReviewRuntimeContext = {
  environment: "review",
  profileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026-review",
  buildId: "R2.0.4-R5",
  deviceId: "review-ai",
  role: "player",
  sessionKind: "official",
  storageKind: "local"
};

const testEncryption: ActiveAttemptEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8")
};

const recordInput: SaveRecordInput = {
  participant_name: "합성 참가자",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0001",
  birth_year: "2012",
  birth_month: "01",
  birth_day: "02",
  privacy_agreed: true,
  privacy_agreed_at: "2026-09-03T01:00:00.000Z",
  stageTexts: ["1234", "5678", "9012"],
  stageTimesMs: [1000, 1000, 1000]
};

function recordRow(recordId: string, participantName: string): RecordRow {
  return { record_id: recordId, participant_name: participantName } as RecordRow;
}

test("review player record listing uses its local review connection", async () => {
  const reviewRows = [recordRow("review-r5-record-00000000-0000-4000-8000-000000000001", "기존 검토 참가자")];
  let legacyReads = 0;

  const rows = await listGeumcheonRecords({
    connection: {
      source: "review",
      runtime: { loadRecords: async () => ({ rows: reviewRows }) }
    },
    role: "player",
    readLegacy: async () => {
      legacyReads += 1;
      return [recordRow("legacy-player", "기존 CSV")];
    }
  });

  assert.equal(rows, reviewRows);
  assert.equal(legacyReads, 0);
});

test("production leaderboard record listing retains NAS runtime records", async () => {
  const nasRows = [recordRow("nas-leaderboard", "기존 NAS 참가자")];
  let legacyReads = 0;

  const rows = await listGeumcheonRecords({
    connection: {
      source: "production",
      runtime: { loadRecords: async () => ({ rows: nasRows }) }
    },
    role: "leaderboard",
    readLegacy: async () => {
      legacyReads += 1;
      return [];
    }
  });

  assert.equal(rows, nasRows);
  assert.equal(legacyReads, 0);
});

test("production player record listing retains legacy records", async () => {
  let runtimeReads = 0;
  const legacyRows = [recordRow("legacy-player", "기존 CSV 참가자")];

  const rows = await listGeumcheonRecords({
    connection: {
      source: "production",
      runtime: {
        loadRecords: async () => {
          runtimeReads += 1;
          return { rows: [recordRow("nas-player", "NAS 플레이어") ] };
        }
      }
    },
    role: "player",
    readLegacy: async () => legacyRows
  });

  assert.equal(rows, legacyRows);
  assert.equal(runtimeReads, 0);
});

test("review startup selects only the injected review connection without production dependencies", async () => {
  let productionCalls = 0;
  let nasRuntimeCalls = 0;
  let credentialStoreCalls = 0;
  let reviewCalls = 0;
  const reviewConnection = { kind: "review" as const };

  const connection = await initializeGeumcheonConnection({
    reviewContext,
    createProduction: async () => {
      productionCalls += 1;
      nasRuntimeCalls += 1;
      credentialStoreCalls += 1;
      return { kind: "production" as const };
    },
    createReview: async (context) => {
      reviewCalls += 1;
      assert.equal(context, reviewContext);
      return reviewConnection;
    }
  });

  assert.equal(connection, reviewConnection);
  assert.equal(reviewCalls, 1);
  assert.equal(productionCalls, 0);
  assert.equal(nasRuntimeCalls, 0);
  assert.equal(credentialStoreCalls, 0);
});

test("production startup retains the required device profile and never selects review", async () => {
  const deviceProfile = { role: "player" } as DeviceProfile;
  let productionCalls = 0;
  let reviewCalls = 0;
  const productionConnection = { kind: "production" as const };

  const connection = await initializeGeumcheonConnection({
    deviceProfile,
    createProduction: async (profile) => {
      productionCalls += 1;
      assert.equal(profile, deviceProfile);
      return productionConnection;
    },
    createReview: async () => {
      reviewCalls += 1;
      return { kind: "review" as const };
    }
  });

  assert.equal(connection, productionConnection);
  assert.equal(productionCalls, 1);
  assert.equal(reviewCalls, 0);

  await assert.rejects(
    initializeGeumcheonConnection({
      createProduction: async () => productionConnection,
      createReview: async () => ({ kind: "review" as const })
    }),
    { message: "GEUMCHEON_DEVICE_PROFILE_REQUIRED" }
  );
});

test("review storage validation requires admin access and returns fixed safe labels", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createReviewLocalRuntime({
    rootDir: root,
    role: "player",
    session: { kind: "official", sessionId: "review-official-1", dayNo: 1, roundNo: 1 }
  });
  let adminGateCalls = 0;

  const normal = await validateReviewStorage({
    reviewContext,
    runtime,
    requireAdmin: () => { adminGateCalls += 1; }
  });

  assert.deepEqual(normal, {
    storage: "local",
    environment: "review",
    role: "player",
    session: "official",
    result: "normal"
  });
  assert.equal(adminGateCalls, 1);

  const recordsDir = path.join(root, "official", "review-official-1", "records");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(recordsDir, "corrupt.json"), "not-json", "utf8");
  const failed = await validateReviewStorage({
    reviewContext,
    runtime,
    requireAdmin: () => { adminGateCalls += 1; }
  });

  assert.deepEqual(failed, {
    storage: "local",
    environment: "review",
    role: "player",
    session: "official",
    result: "error"
  });
  assert.equal(adminGateCalls, 2);
  assert.doesNotMatch(JSON.stringify(failed), /typingking-r5-review-validation|REVIEW_RECORD_CORRUPT|https?:\/\/|token|identity/i);

  await assert.rejects(
    validateReviewStorage({
      reviewContext,
      runtime,
      requireAdmin: () => { throw new Error("ADMIN_AUTH_REQUIRED"); }
    }),
    { message: "ADMIN_AUTH_REQUIRED" }
  );
});

test("review readiness fails closed when the local storage root is unavailable", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-readiness-"));
  const unavailableRoot = path.join(parent, "storage-root");
  fs.writeFileSync(unavailableRoot, "not-a-directory", "utf8");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const connection = createReviewGeumcheonConnection({
    reviewContext,
    runtimeRoot: unavailableRoot,
    encryption: testEncryption,
    persistLocal: async (input, recordId) => ({ record_id: recordId, ...buildRecordRow(input) })
  });

  assert.deepEqual(await connection.checkReadiness(), {
    ready: false,
    message: "로컬 검토 저장소를 확인할 수 없습니다."
  });
});

test("review connection keeps checkpoint, records and admin mutations on the actual local runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-connection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connection = createReviewGeumcheonConnection({
    reviewContext,
    runtimeRoot: root,
    encryption: testEncryption,
    now: () => "2026-09-03T01:00:00.000Z",
    persistLocal: async (input, recordId) => ({ record_id: recordId, ...buildRecordRow(input) })
  });

  const checkpoint = await connection.runtime.checkpoint(recordInput);
  const saved = await connection.runtime.save(recordInput);
  assert.equal(saved.record_id, checkpoint.recordId);
  assert.deepEqual((await connection.runtime.loadRecords()).rows.map((row) => row.record_id), [saved.record_id]);
  assert.deepEqual(await connection.checkReadiness(), { ready: true });

  await connection.runtime.edit(saved.record_id, { ...saved, participant_name: "수정 참가자" }, "관리자");
  assert.equal((await connection.runtime.loadRecords()).rows[0].participant_name, "수정 참가자");
  await connection.runtime.hide(saved.record_id, true, "관리자");
  assert.deepEqual((await connection.runtime.loadRecords()).rows, []);
  await connection.runtime.resetSession("관리자");
  assert.deepEqual(await connection.runtime.queueStatus(), { pending: 0, blocked: 0 });
  const createdPaths = fs.readdirSync(root, { recursive: true }).map(String);
  assert.equal(createdPaths.some((entry) => /records\.csv|local_queue|recovery|incoming/i.test(entry)), false);
});
