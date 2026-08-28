import type { RecordRow, SaveRecordInput } from "../shared/types";

export type ActiveAttemptCheckpoint = {
  schemaVersion: 1;
  eventProfileId: "geumcheon-2026";
  variant: "ai" | "practice";
  recordId: string;
  updatedAt: string;
  input: SaveRecordInput;
};

export type ActiveAttemptStoreLike = {
  save(checkpoint: ActiveAttemptCheckpoint): Promise<void>;
  read(): Promise<ActiveAttemptCheckpoint | null>;
  clear(): Promise<void>;
};

export type GeumcheonRecordRuntime = {
  checkpoint(input: SaveRecordInput): Promise<ActiveAttemptCheckpoint>;
  save(input: SaveRecordInput): Promise<RecordRow>;
  recover(): Promise<RecordRow | null>;
};

export function createGeumcheonRecordRuntime(options: {
  eventProfileId: "geumcheon-2026";
  variant: "ai" | "practice";
  store: ActiveAttemptStoreLike;
  createRecordId(): string;
  now(): string;
  persistLocal(input: SaveRecordInput, recordId: string): Promise<RecordRow>;
  enqueue(row: RecordRow): Promise<void>;
}): GeumcheonRecordRuntime {
  let cached: ActiveAttemptCheckpoint | null | undefined;
  let operation = Promise.resolve<void>(undefined);

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = operation.then(task, task);
    operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function current(): Promise<ActiveAttemptCheckpoint | null> {
    if (cached === undefined) cached = await options.store.read();
    return cached;
  }

  async function writeCheckpoint(input: SaveRecordInput): Promise<ActiveAttemptCheckpoint> {
    const previous = await current();
    const checkpoint: ActiveAttemptCheckpoint = {
      schemaVersion: 1,
      eventProfileId: options.eventProfileId,
      variant: options.variant,
      recordId: previous?.recordId ?? options.createRecordId(),
      updatedAt: options.now(),
      input
    };
    await options.store.save(checkpoint);
    cached = checkpoint;
    return checkpoint;
  }

  async function persist(checkpoint: ActiveAttemptCheckpoint): Promise<RecordRow> {
    const row = await options.persistLocal(checkpoint.input, checkpoint.recordId);
    await options.enqueue(row);
    await options.store.clear();
    cached = null;
    return row;
  }

  return {
    checkpoint: (input) => exclusive(() => writeCheckpoint(input)),
    save: (input) => exclusive(async () => persist(await writeCheckpoint(input))),
    recover: () => exclusive(async () => {
      const checkpoint = await current();
      return checkpoint ? persist(checkpoint) : null;
    })
  };
}
