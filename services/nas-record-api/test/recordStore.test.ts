import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { RecordStore } from "../src/recordStore.js";
import type { StoredNasRecordV1 } from "../src/recordSchema.js";

const RECORD_ID = "gsc26-pc01-11111111-1111-4111-8111-111111111111";

function validStoredRecord(overrides: Partial<StoredNasRecordV1["record"]> = {}): StoredNasRecordV1 {
  const record = {
    record_id: RECORD_ID,
    created_at: "2026-08-26T03:00:00.000Z",
    completed_at: "2026-08-26T03:00:06.000Z",
    participant: { name: "synthetic", phone: "010-0000-0001", phone_masked: "010-****-0001", birthdate: "2000-02-29", birthdate_masked: "2000-**-**", privacy_agreed: true as const, privacy_agreed_at: "2026-08-26T02:59:59.000Z" },
    participant_key: "a".repeat(64),
    status: "success" as const,
    stages: [{ stage_no: 1 as const, text_id: "s1", catalog_version: "v1", target_text: "가", typed_text: "가", user_time_ms: 1000, ai_cpm: 150, result: "USER_WIN" as const, typing_units: 2 }],
    app_version: "synthetic", is_test: false, is_debug: false, debug_mode_type: "" as const,
    authenticated_device_id: "PC01", total_typing_units: 2, total_user_time_ms: 1000,
    effective_cpm_numerator: 120000, effective_cpm_denominator: 1000, display_cpm: 120,
    received_at: "2026-08-26T03:10:00.000Z", ...overrides,
  };
  const mutable = { schema_version: 1 as const, event_id: "geumcheon-science-festival-2026" as const, session: { kind: "official" as const, session_id: "official-day1-round1", day_no: 1, round_no: 1 }, payload_sha256: "b".repeat(64), record };
  return mutable as StoredNasRecordV1;
}

function incoming(root: string, practice = false): string {
  return practice
    ? join(root, "기록저장", "연습회차", "incoming", "ai")
    : join(root, "기록저장", "1일차", "1회차", "incoming", "ai");
}

function jsonFiles(root: string): string[] {
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? visit(join(directory, entry.name)) : entry.name.endsWith(".json") ? [join(directory, entry.name)] : []);
  return visit(root);
}

test("publishes one file for concurrent identical requests", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  const results = await Promise.all(Array.from({ length: 20 }, () => store.put(validStoredRecord())));
  assert.equal(results.filter((item) => item.disposition === "stored").length, 1);
  assert.equal(results.filter((item) => item.disposition === "duplicate").length, 19);
  assert.equal(jsonFiles(root).length, 1);
  assert.equal(readdirSync(incoming(root)).filter((name) => name.includes(".tmp-")).length, 0);
});

test("never replaces an existing ID with different content", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  const original = validStoredRecord();
  await store.put(original);
  const target = join(incoming(root), `${RECORD_ID}.json`);
  const saved = readFileSync(target, "utf8");
  const changed = validStoredRecord({ participant: { ...original.record.participant, name: "different" } });
  changed.payload_sha256 = "c".repeat(64);
  await assert.rejects(() => store.put(changed), /IDEMPOTENCY_CONFLICT/);
  assert.equal(readFileSync(target, "utf8"), saved);
});

test("uses the exact official and practice incoming paths", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  await store.put(validStoredRecord());
  const practice = validStoredRecord({ record_id: "gsc26-pc01-22222222-2222-4222-8222-222222222222" });
  practice.session = { kind: "practice", session_id: "practice-2026" };
  await store.put(practice);
  assert.equal(jsonFiles(root).includes(join(incoming(root), `${RECORD_ID}.json`)), true);
  assert.equal(jsonFiles(root).includes(join(incoming(root, true), `${practice.record.record_id}.json`)), true);
});

test("response-loss retry after restart is a durable duplicate", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const record = validStoredRecord();
  await new RecordStore({ dataRoot: root }).put(record);
  const retried = await new RecordStore({ dataRoot: root }).put(record);
  assert.equal(retried.disposition, "duplicate");
  assert.equal(retried.payloadSha256, record.payload_sha256);
  assert.equal(jsonFiles(root).length, 1);
  assert.equal(readdirSync(incoming(root)).some((name) => name.includes(".tmp-")), false);
});

test("never reports a new completed save after write link or directory sync faults", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const fault of ["beforeWrite", "beforeFileSync", "beforeLink", "beforeDirectorySync"] as const) {
    const store = new RecordStore({ dataRoot: root, atomicHooks: { [fault]: () => { throw new Error(`FAULT_${fault}`); } } });
    await assert.rejects(() => store.put(validStoredRecord()), new RegExp(`FAULT_${fault}`));
    const files = jsonFiles(root);
    if (fault === "beforeDirectorySync") {
      assert.equal(files.length, 1);
      assert.equal((await new RecordStore({ dataRoot: root }).put(validStoredRecord())).disposition, "duplicate");
    } else {
      assert.equal(files.length, 0);
    }
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
  }
});

test("treats an empty or malformed existing target as corrupt without replacing it", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDirectory = incoming(root);
  mkdirSync(targetDirectory, { recursive: true });
  const target = join(targetDirectory, `${RECORD_ID}.json`);
  writeFileSync(target, "");
  await assert.rejects(() => new RecordStore({ dataRoot: root }).put(validStoredRecord()), /STORAGE_CORRUPT/);
  assert.equal(readFileSync(target, "utf8"), "");
});
