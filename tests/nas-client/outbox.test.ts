import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedNasOutbox } from "../../electron/nas/outbox";
import type { SafeStorageAdapter } from "../../electron/nas/credentialStore";
import type { NasRecordEnvelopeV1 } from "../../shared/nas/protocol";

const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
const envelope = {
  schema_version: 1,
  event_id: "geumcheon-science-festival-2026",
  session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
  row: { record_id: recordId, participant_name: "홍길동", phone_full: "01012345678" },
} as NasRecordEnvelopeV1;

const safeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`cipher:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(value.toString().slice("cipher:".length), "base64").toString(),
};

test("keeps official and practice records in separate encrypted atomic files", async (context) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "typingking-outbox-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const outbox = new EncryptedNasOutbox({ rootDir, safeStorage });

  await outbox.enqueue("official", envelope);
  await outbox.enqueue("practice", { ...envelope, session: { kind: "practice", session_id: "practice-1" } });

  const officialNames = await readdir(path.join(rootDir, "official", "pending"));
  const practiceNames = await readdir(path.join(rootDir, "practice", "pending"));
  assert.deepEqual(officialNames, [`${recordId}.bin`]);
  assert.deepEqual(practiceNames, [`${recordId}.bin`]);
  const bytes = await readFile(path.join(rootDir, "official", "pending", officialNames[0]));
  assert.equal(bytes.includes(Buffer.from("홍길동")), false);
  assert.equal((await outbox.list("official"))[0].envelope.row.record_id, recordId);
  assert.equal(officialNames.some((name) => name.includes(".tmp-")), false);
});

test("uses the existing record ID as the stable idempotency key and rejects changed reuse", async (context) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "typingking-outbox-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const outbox = new EncryptedNasOutbox({ rootDir, safeStorage });

  await outbox.enqueue("official", envelope);
  await outbox.enqueue("official", envelope);
  assert.equal((await outbox.list("official")).length, 1);
  await assert.rejects(
    () => outbox.enqueue("official", { ...envelope, row: { ...envelope.row, participant_name: "다른 이름" } }),
    /OUTBOX_RECORD_ID_CONFLICT/,
  );
});

test("moves permanent failures to an encrypted blocked area without deleting evidence", async (context) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "typingking-outbox-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const outbox = new EncryptedNasOutbox({ rootDir, safeStorage });

  await outbox.enqueue("official", envelope);
  await outbox.block("official", recordId, "HTTP_422");

  assert.equal((await outbox.list("official")).length, 0);
  const blocked = await outbox.listBlocked("official");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].recordId, recordId);
  assert.equal(blocked[0].reason, "HTTP_422");
  const bytes = await readFile(path.join(rootDir, "official", "blocked", `${recordId}.bin`));
  assert.equal(bytes.includes(Buffer.from("홍길동")), false);
});
