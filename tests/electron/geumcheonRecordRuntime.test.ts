import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeumcheonRecordRuntime,
  type AttemptPersistenceIdentity,
} from "../../electron/geumcheonRecordRuntime";
import type { RecordRow, SaveRecordInput } from "../../shared/types";

const input = {
  participant_name: "합성참가자",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0001",
  birth_year: "2012",
  birth_month: "1",
  birth_day: "2",
  privacy_agreed: true,
  privacy_agreed_at: "2026-09-18T01:00:00.000Z",
  stageTexts: ["첫 문장", "둘째 문장", "셋째 문장"],
  stageTimesMs: [1_000, 0, 0],
  game_mode: "ai_challenge",
  final_accuracy: 80,
  interruption: {
    action: "exit",
    resultStage: 1,
    participantProgressPercent: 12.5,
    stageCharCounts: [4, 0, 0],
    totalTypingUnits: 7
  }
} as SaveRecordInput;

function inputWithRendererIdentity(): SaveRecordInput {
  return {
    ...input,
    canonicalAttempt: {
      schemaVersion: 1,
      attemptId: "gsc26-attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      recordId: "gsc26-pc10-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deviceId: "PC10",
      recordedAt: "2026-09-18T00:00:00.000Z",
      result: "INTERRUPTED",
      interruptionReason: "RETRY",
      participantFinishTimeMs: null,
      geumnaraeFinishTimeMs: null,
      stages: [],
      stageReached: 1,
      stageState: "IN_PROGRESS",
      wholeGameProgressRaw: 0,
      participantAverageCpmRaw: 0,
      geumnaraeProgressRaw: 0,
      geumnaraeAverageCpmRaw: 0,
      totalActiveDuelTimeMs: 0,
      assignedInputUnits: 0,
      participantCorrectInputUnits: 0,
      participantValidInputUnits: 0,
      participantActiveTypingTimeMs: 0,
      geumnaraeCorrectInputUnits: 0,
      geumnaraeValidInputUnits: 0,
      geumnaraeActiveTypingTimeMs: 0,
      participantCompleted: false,
      geumnaraeCompleted: false,
      contradictionCodes: ["IDENTITY_MISMATCH"],
    },
  };
}

function row(recordId: string): RecordRow {
  return { record_id: recordId, participant_name: "합성참가자", game_mode: "ai_challenge" } as RecordRow;
}

function memoryStore(initial: any = null) {
  let checkpoint = initial;
  return {
    get value() { return checkpoint; },
    async save(value: any) { checkpoint = structuredClone(value); },
    async read() { return checkpoint == null ? null : structuredClone(checkpoint); },
    async clear() { checkpoint = null; }
  };
}

test("keeps one record ID from active checkpoint through local save and NAS outbox", async () => {
  const store = memoryStore();
  const savedIds: string[] = [];
  const queuedIds: string[] = [];
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    }),
    now: () => "2026-09-18T01:00:01.000Z",
    persistLocal: async (_input, identity) => {
      savedIds.push(identity.recordId);
      return row(identity.recordId);
    },
    enqueue: async (saved) => { queuedIds.push(saved.record_id); }
  });

  const checkpoint = await runtime.checkpoint(input);
  const saved = await runtime.save(input);

  assert.equal(checkpoint.recordId, saved.record_id);
  assert.deepEqual(savedIds, [checkpoint.recordId]);
  assert.deepEqual(queuedIds, [checkpoint.recordId]);
  assert.equal(store.value, null);
});

test("recovers a forced-exit checkpoint and keeps it when outbox persistence fails", async () => {
  const checkpoint = {
    schemaVersion: 2 as const,
    eventProfileId: "geumcheon-2026",
    variant: "ai" as const,
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    recordedAt: "2026-09-18T01:00:01.000Z",
    updatedAt: "2026-09-18T01:00:01.000Z",
    input
  };
  const store = memoryStore(checkpoint);
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => { throw new Error("must reuse checkpoint identity"); },
    now: () => "2026-09-18T01:00:02.000Z",
    persistLocal: async (_input, identity) => row(identity.recordId),
    enqueue: async () => { throw new Error("offline queue unavailable"); }
  });

  await assert.rejects(() => runtime.recover(), /offline queue unavailable/);
  assert.equal(store.value?.recordId, checkpoint.recordId);
});

test("keeps paired IDs and recordedAt immutable across checkpoint updates and persistence", async () => {
  const store = memoryStore();
  const persisted: Array<{
    recordId: string;
    attemptId: string;
    deviceId: string;
    recordedAt: string;
  }> = [];
  const timestamps = [
    "2026-09-18T01:00:01.000Z",
    "2026-09-18T01:00:02.000Z",
    "2026-09-18T01:00:03.000Z",
  ];
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    }),
    now: () => timestamps.shift()!,
    persistLocal: async (_input, identity) => {
      persisted.push(identity);
      return row(identity.recordId);
    },
    enqueue: async () => undefined,
  });

  const first = await runtime.checkpoint(input);
  const updated = await runtime.checkpoint({ ...input, final_accuracy: 81 });
  await runtime.save({ ...input, final_accuracy: 82 });

  assert.deepEqual(first, {
    schemaVersion: 2,
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    recordedAt: "2026-09-18T01:00:01.000Z",
    updatedAt: "2026-09-18T01:00:01.000Z",
    input,
  });
  assert.equal(updated.recordedAt, first.recordedAt);
  assert.equal(updated.updatedAt, "2026-09-18T01:00:02.000Z");
  assert.deepEqual(persisted, [{
    recordId: first.recordId,
    attemptId: first.attemptId,
    deviceId: "PC01",
    recordedAt: first.recordedAt,
  }]);
});

test("recovery reuses the exact trusted identity after an outbox failure", async () => {
  const store = memoryStore();
  const persistedInputs: SaveRecordInput[] = [];
  const persistedIdentities: AttemptPersistenceIdentity[] = [];
  let enqueueCalls = 0;
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    }),
    now: () => "2026-09-18T01:00:01.000Z",
    persistLocal: async (savedInput, identity) => {
      persistedInputs.push(structuredClone(savedInput));
      persistedIdentities.push(structuredClone(identity));
      return row(identity.recordId);
    },
    enqueue: async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) throw new Error("synthetic offline");
    },
  });

  await assert.rejects(runtime.save(inputWithRendererIdentity()), /synthetic offline/);
  await runtime.recover();

  assert.deepEqual(persistedIdentities, [
    {
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
      deviceId: "PC01",
      recordedAt: "2026-09-18T01:00:01.000Z",
    },
    {
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
      deviceId: "PC01",
      recordedAt: "2026-09-18T01:00:01.000Z",
    },
  ]);
  assert.deepEqual(
    persistedInputs.map((savedInput) => ({
      attemptId: savedInput.canonicalAttempt?.attemptId,
      recordId: savedInput.canonicalAttempt?.recordId,
      deviceId: savedInput.canonicalAttempt?.deviceId,
      recordedAt: savedInput.canonicalAttempt?.recordedAt,
    })),
    persistedIdentities,
  );
  assert.deepEqual(
    persistedInputs.map((savedInput) =>
      savedInput.canonicalAttempt?.contradictionCodes.includes("IDENTITY_MISMATCH")
    ),
    [false, false],
  );
});

test("a new user retry receives a fresh paired identity", async () => {
  const store = memoryStore();
  const pairs = [
    {
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    },
    {
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174001",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174001",
    },
  ];
  const persistedInputs: SaveRecordInput[] = [];
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => pairs.shift()!,
    now: () => "2026-09-18T01:00:01.000Z",
    persistLocal: async (savedInput, identity) => {
      persistedInputs.push(structuredClone(savedInput));
      return row(identity.recordId);
    },
    enqueue: async () => undefined,
  });

  await runtime.save(inputWithRendererIdentity());
  await runtime.save(inputWithRendererIdentity());

  assert.deepEqual(
    persistedInputs.map((savedInput) => ({
      attemptId: savedInput.canonicalAttempt?.attemptId,
      recordId: savedInput.canonicalAttempt?.recordId,
      deviceId: savedInput.canonicalAttempt?.deviceId,
    })),
    [
      {
        attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
        recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
        deviceId: "PC01",
      },
      {
        attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174001",
        recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174001",
        deviceId: "PC01",
      },
    ],
  );
});

test("rejects an identity generated for a different trusted device", async () => {
  const store = memoryStore();
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    deviceId: "PC01",
    store,
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc02-123e4567-e89b-42d3-a456-426614174000",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    }),
    now: () => "2026-09-18T01:00:01.000Z",
    persistLocal: async () => {
      throw new Error("must not persist");
    },
    enqueue: async () => {
      throw new Error("must not enqueue");
    },
  });

  await assert.rejects(runtime.checkpoint(input), /ATTEMPT_IDENTITY_DEVICE_MISMATCH/);
  assert.equal(store.value, null);
});
