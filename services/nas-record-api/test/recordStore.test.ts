import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { payloadSha256, type NasSessionV1 } from "../../../shared/nas/protocol.js";
import type { RecordRow } from "../../../shared/types/index.js";
import { RecordStore } from "../src/recordStore.js";
import type { StoredNasRecordV1 } from "../src/recordSchema.js";
import {
  OFFICIAL_SESSION,
  PRACTICE_SESSION,
  RECEIVED_AT,
  envelope,
  recordRow,
} from "./fixtures.js";

const RECORD_ID = "gsc26-pc01-11111111-1111-4111-8111-111111111111";

function validStoredRecord(
  overrides: Partial<RecordRow> = {},
  session: NasSessionV1 = OFFICIAL_SESSION,
): StoredNasRecordV1 {
  const submitted = envelope(recordRow(overrides), session);
  return {
    ...submitted,
    payload_sha256: payloadSha256(submitted),
    authenticated_device_id: "PC01",
    received_at: RECEIVED_AT,
  };
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
  const changed = validStoredRecord({ participant_name: "different" });
  await assert.rejects(() => store.put(changed), /IDEMPOTENCY_CONFLICT/);
  assert.equal(readFileSync(target, "utf8"), saved);
});

test("uses the exact official and practice incoming paths", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  await store.put(validStoredRecord());
  const practice = validStoredRecord(
    { record_id: "gsc26-pc01-22222222-2222-4222-8222-222222222222" },
    PRACTICE_SESSION,
  );
  await store.put(practice);
  assert.equal(jsonFiles(root).includes(join(incoming(root), `${RECORD_ID}.json`)), true);
  assert.equal(jsonFiles(root).includes(join(incoming(root, true), `${practice.row.record_id}.json`)), true);
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

test("treats a same-hash structurally incomplete existing target as corrupt without replacing it", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDirectory = incoming(root);
  mkdirSync(targetDirectory, { recursive: true });
  const target = join(targetDirectory, `${RECORD_ID}.json`);
  const record = validStoredRecord();
  writeFileSync(target, JSON.stringify({ record_id: record.row.record_id }));
  const original = readFileSync(target, "utf8");
  await assert.rejects(() => new RecordStore({ dataRoot: root }).put(record), /STORAGE_CORRUPT/);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("rejects an incoming parent redirected through a symlink or junction before writing", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const redirected = join(root, "outside");
  const incomingDirectory = incoming(root);
  mkdirSync(redirected);
  mkdirSync(dirname(incomingDirectory), { recursive: true });
  try {
    symlinkSync(redirected, incomingDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip(`symlink/junction creation unavailable: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "unknown"}`);
    return;
  }
  await assert.rejects(() => new RecordStore({ dataRoot: root }).put(validStoredRecord()), /STORAGE_PATH_SUBSTITUTION/);
  assert.equal(readdirSync(redirected).length, 0);
});

test("rejects an intermediate redirected parent before it can create a child outside the data root", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-store-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const redirected = join(root, "outside");
  const incomingDirectory = incoming(root);
  const intermediateParent = dirname(incomingDirectory);
  mkdirSync(redirected);
  mkdirSync(dirname(intermediateParent), { recursive: true });
  try {
    symlinkSync(redirected, intermediateParent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip(`symlink/junction creation unavailable: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "unknown"}`);
    return;
  }
  await assert.rejects(() => new RecordStore({ dataRoot: root }).put(validStoredRecord()), /STORAGE_PATH_SUBSTITUTION/);
  assert.deepEqual(readdirSync(redirected), []);
});
