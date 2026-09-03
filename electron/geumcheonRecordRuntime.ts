import type { RecordRow, SaveRecordInput } from "../shared/types";
import type { GeumcheonAttemptIdentityIds } from "../shared/nas/protocol";
import { isPairedGeumcheonAttemptIdentity } from "../shared/nas/protocol";
import { canonicalAiContradictionCodes } from "../shared/utils/geumcheonAiAttempt";

export type ActiveAttemptCheckpoint = {
  schemaVersion: 2;
  eventProfileId: string;
  variant: "ai" | "practice";
  recordId: string;
  attemptId: string;
  recordedAt: string;
  updatedAt: string;
  input: SaveRecordInput;
};

export type AttemptPersistenceIdentity = GeumcheonAttemptIdentityIds & {
  deviceId: string;
  recordedAt: string;
};

export type AttemptIdentityPolicy = {
  isTrusted(recordId: unknown, attemptId: unknown): boolean;
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
  deviceId: string;
  store: ActiveAttemptStoreLike;
  createAttemptIdentity(): GeumcheonAttemptIdentityIds;
  now(): string;
  persistLocal(input: SaveRecordInput, identity: AttemptPersistenceIdentity): Promise<RecordRow>;
  enqueue(row: RecordRow): Promise<void>;
  identityPolicy?: AttemptIdentityPolicy;
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
    const updatedAt = options.now();
    const identity = previous ?? options.createAttemptIdentity();
    assertTrustedIdentity(identity, options.deviceId, options.identityPolicy);
    const recordedAt = previous?.recordedAt ?? updatedAt;
    const checkpoint: ActiveAttemptCheckpoint = {
      schemaVersion: 2,
      eventProfileId: options.eventProfileId,
      variant: options.variant,
      recordId: identity.recordId,
      attemptId: identity.attemptId,
      recordedAt,
      updatedAt,
      input: withTrustedIdentity(input, {
        recordId: identity.recordId,
        attemptId: identity.attemptId,
        deviceId: options.deviceId,
        recordedAt,
      }),
    };
    await options.store.save(checkpoint);
    cached = checkpoint;
    return checkpoint;
  }

  async function persist(checkpoint: ActiveAttemptCheckpoint): Promise<RecordRow> {
    assertTrustedIdentity(checkpoint, options.deviceId, options.identityPolicy);
    const identity = {
      recordId: checkpoint.recordId,
      attemptId: checkpoint.attemptId,
      deviceId: options.deviceId,
      recordedAt: checkpoint.recordedAt,
    };
    const row = await options.persistLocal(
      withTrustedIdentity(checkpoint.input, identity),
      identity,
    );
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

function assertTrustedIdentity(
  identity: GeumcheonAttemptIdentityIds,
  deviceId: string,
  identityPolicy?: AttemptIdentityPolicy,
): void {
  if (identityPolicy != null) {
    if (!identityPolicy.isTrusted(identity.recordId, identity.attemptId)) {
      throw new Error("ATTEMPT_IDENTITY_INVALID");
    }
    return;
  }
  if (!isPairedGeumcheonAttemptIdentity(identity.recordId, identity.attemptId)) {
    throw new Error("ATTEMPT_IDENTITY_INVALID");
  }
  if (!identity.recordId.startsWith(`gsc26-${deviceId.toLowerCase()}-`)) {
    throw new Error("ATTEMPT_IDENTITY_DEVICE_MISMATCH");
  }
}

function withTrustedIdentity(
  input: SaveRecordInput,
  identity: AttemptPersistenceIdentity,
): SaveRecordInput {
  if (input.canonicalAttempt == null) return input;
  const canonicalAttempt = {
    ...input.canonicalAttempt,
    attemptId: identity.attemptId,
    recordId: identity.recordId,
    deviceId: identity.deviceId,
    recordedAt: identity.recordedAt,
  };
  canonicalAttempt.contradictionCodes = canonicalAiContradictionCodes(
    canonicalAttempt,
    identity,
  );
  return {
    ...input,
    canonicalAttempt,
  };
}
