import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeumcheonRecordRuntime,
  type ActiveAttemptCheckpoint
} from "../../electron/geumcheonRecordRuntime";
import type { RecordRow, SaveRecordInput } from "../../shared/types";

test("queues the close-time snapshot before fallback recovery to avoid a duplicate loss", async () => {
  const periodicInput = { participant_name: "주기 저장" } as SaveRecordInput;
  const closeInput = { participant_name: "종료 시점 저장" } as SaveRecordInput;
  let stored: ActiveAttemptCheckpoint | null = null;
  let saveCalls = 0;
  let releasePeriodicSave = () => {};
  let markPeriodicSaveStarted = () => {};
  const periodicSaveStarted = new Promise<void>((resolve) => {
    markPeriodicSaveStarted = resolve;
  });
  const periodicSaveBlocked = new Promise<void>((resolve) => {
    releasePeriodicSave = resolve;
  });
  const persistedInputs: SaveRecordInput[] = [];

  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store: {
      async save(checkpoint) {
        saveCalls += 1;
        if (saveCalls === 1) {
          markPeriodicSaveStarted();
          await periodicSaveBlocked;
        }
        stored = checkpoint;
      },
      async read() {
        return stored;
      },
      async clear() {
        stored = null;
      }
    },
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    }),
    now: () => "2026-08-26T00:00:00.000Z",
    async persistLocal(input, identity) {
      persistedInputs.push(input);
      return { record_id: identity.recordId } as RecordRow;
    },
    async enqueue() {}
  });

  const periodicWrite = runtime.checkpoint(periodicInput);
  await periodicSaveStarted;
  const closeWrite = runtime.checkpoint(closeInput);
  const fallbackRecovery = runtime.recover();
  releasePeriodicSave();

  await periodicWrite;
  await closeWrite;
  const recovered = await fallbackRecovery;

  assert.equal(recovered?.record_id, "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(persistedInputs, [closeInput]);
  assert.equal(await runtime.recover(), null);
});
