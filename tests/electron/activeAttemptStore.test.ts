import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createActiveAttemptStore,
  type ActiveAttemptCheckpointV1,
  type ActiveAttemptEncryption,
} from "../../electron/activeAttemptStore";
import type { SaveRecordInput } from "../../shared/types";

const KEY = Buffer.alloc(32, 7);

function encryptionAdapter(): ActiveAttemptEncryption {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

function saveInput(): SaveRecordInput {
  return {
    participant_name: "중단참가자",
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    birth_year: "2014",
    birth_month: "1",
    birth_day: "2",
    privacy_agreed: true,
    privacy_agreed_at: "2026-08-26T01:00:00.000Z",
    stageTexts: ["첫 문장", "둘째 문장", "셋째 문장"],
    stageTimesMs: [1_000, 0, 0],
    game_mode: "ai_challenge",
    interruption: {
      action: "retry",
      resultStage: 1,
      participantProgressPercent: 40,
      stageCharCounts: [4, 0, 0],
      totalTypingUnits: 8,
    },
  };
}

function checkpoint(): ActiveAttemptCheckpointV1 {
  return {
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    updatedAt: "2026-08-26T01:02:03.000Z",
    input: saveInput(),
  };
}

test("stores an active attempt encrypted and restores the same checkpoint", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
    });
    const activeAttempt = checkpoint();

    await store.save(activeAttempt);

    const encrypted = fs.readFileSync(checkpointPath);
    assert.equal(encrypted.includes(Buffer.from("중단참가자", "utf8")), false);
    assert.deepEqual(await store.read(), activeAttempt);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("stores a program-exit interruption checkpoint for recovery after forced shutdown", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-exit-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
    });
    const activeAttempt = checkpoint();
    activeAttempt.input.interruption!.action = "exit";

    await store.save(activeAttempt);

    assert.equal((await store.read())?.input.interruption?.action, "exit");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects unknown checkpoint fields without deleting the corrupt file", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  const encryption = encryptionAdapter();
  try {
    const malformed = { ...checkpoint(), unexpected: "raw-private-data" };
    fs.writeFileSync(checkpointPath, encryption.encryptString(JSON.stringify(malformed)));
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(store.read(), { message: "ACTIVE_ATTEMPT_INVALID_CHECKPOINT" });
    assert.equal(fs.existsSync(checkpointPath), true);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("surfaces a safe decrypt error and preserves the encrypted checkpoint", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  const encrypted = Buffer.from("not-a-valid-encrypted-checkpoint");
  fs.writeFileSync(checkpointPath, encrypted);
  try {
    const failingEncryption: ActiveAttemptEncryption = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from("unused"),
      decryptString: () => {
        throw new Error("중단참가자 010-1234-5678");
      },
    };
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: failingEncryption,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(store.read(), { message: "ACTIVE_ATTEMPT_DECRYPTION_FAILED" });
    assert.deepEqual(fs.readFileSync(checkpointPath), encrypted);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects an oversized encrypted checkpoint before decryption", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  fs.writeFileSync(checkpointPath, Buffer.alloc(65, 1));
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
      maxEncryptedBytes: 64,
    });

    await assert.rejects(store.read(), { message: "ACTIVE_ATTEMPT_TOO_LARGE" });
    assert.equal(fs.statSync(checkpointPath).size, 65);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("never writes plaintext when encryption is unavailable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  try {
    const unavailable: ActiveAttemptEncryption = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(JSON.stringify(checkpoint())),
      decryptString: () => "",
    };
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: unavailable,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(store.save(checkpoint()), {
      message: "ACTIVE_ATTEMPT_ENCRYPTION_UNAVAILABLE",
    });
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("hides errors thrown while checking encryption availability", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  try {
    const failingAvailability: ActiveAttemptEncryption = {
      isEncryptionAvailable: () => {
        throw new Error("중단참가자 010-1234-5678");
      },
      encryptString: () => Buffer.from("unused"),
      decryptString: () => "",
    };
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: failingAvailability,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(store.save(checkpoint()), {
      message: "ACTIVE_ATTEMPT_ENCRYPTION_UNAVAILABLE",
    });
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("preserves the previous checkpoint when encryption of an update fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  const encryption = encryptionAdapter();
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption,
      eventProfileId: "geumcheon-2026",
    });
    const original = checkpoint();
    await store.save(original);

    const failingEncryption: ActiveAttemptEncryption = {
      ...encryption,
      encryptString: () => {
        throw new Error("중단참가자 010-1234-5678");
      },
    };
    const failingStore = createActiveAttemptStore({
      checkpointPath,
      encryption: failingEncryption,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(failingStore.save({ ...original, updatedAt: "2026-08-26T01:03:00.000Z" }), {
      message: "ACTIVE_ATTEMPT_ENCRYPTION_FAILED",
    });
    assert.deepEqual(await store.read(), original);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("clear removes only the exact checkpoint file", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  const siblingPath = path.join(runtimeRoot, "active-attempt.bin.backup");
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
    });
    await store.save(checkpoint());
    fs.writeFileSync(siblingPath, "keep");

    await store.clear();

    assert.equal(fs.existsSync(checkpointPath), false);
    assert.equal(fs.readFileSync(siblingPath, "utf8"), "keep");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("returns null when no active checkpoint exists", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  try {
    const store = createActiveAttemptStore({
      checkpointPath: path.join(runtimeRoot, "active-attempt.bin"),
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
    });

    assert.equal(await store.read(), null);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects unknown nested SaveRecordInput fields", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  const encryption = encryptionAdapter();
  try {
    const malformed = checkpoint() as ActiveAttemptCheckpointV1 & {
      input: SaveRecordInput & { unexpected?: string };
    };
    malformed.input.unexpected = "must-not-be-accepted";
    fs.writeFileSync(checkpointPath, encryption.encryptString(JSON.stringify(malformed)));
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption,
      eventProfileId: "geumcheon-2026",
    });

    await assert.rejects(store.read(), { message: "ACTIVE_ATTEMPT_INVALID_CHECKPOINT" });
    assert.equal(fs.existsSync(checkpointPath), true);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("atomically replaces an earlier checkpoint without leftover temporary files", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-active-attempt-"));
  const checkpointPath = path.join(runtimeRoot, "active-attempt.bin");
  try {
    const store = createActiveAttemptStore({
      checkpointPath,
      encryption: encryptionAdapter(),
      eventProfileId: "geumcheon-2026",
    });
    const original = checkpoint();
    const updated = {
      ...original,
      updatedAt: "2026-08-26T01:04:00.000Z",
      input: { ...original.input, stageTimesMs: [2_000, 0, 0] as [number, number, number] },
    };

    await store.save(original);
    await store.save(updated);

    assert.deepEqual(await store.read(), updated);
    assert.deepEqual(fs.readdirSync(runtimeRoot), ["active-attempt.bin"]);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
