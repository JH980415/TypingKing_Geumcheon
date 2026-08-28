import assert from "node:assert/strict";
import test from "node:test";
import { createGeumcheonRecordRuntime } from "../../electron/geumcheonRecordRuntime";
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
    store,
    createRecordId: () => "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    now: () => "2026-09-18T01:00:01.000Z",
    persistLocal: async (_input, recordId) => { savedIds.push(recordId); return row(recordId); },
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
    schemaVersion: 1 as const,
    eventProfileId: "geumcheon-2026",
    variant: "ai" as const,
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    updatedAt: "2026-09-18T01:00:01.000Z",
    input
  };
  const store = memoryStore(checkpoint);
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026",
    variant: "ai",
    store,
    createRecordId: () => { throw new Error("must reuse checkpoint ID"); },
    now: () => "2026-09-18T01:00:02.000Z",
    persistLocal: async (_input, recordId) => row(recordId),
    enqueue: async () => { throw new Error("offline queue unavailable"); }
  });

  await assert.rejects(() => runtime.recover(), /offline queue unavailable/);
  assert.equal(store.value?.recordId, checkpoint.recordId);
});
