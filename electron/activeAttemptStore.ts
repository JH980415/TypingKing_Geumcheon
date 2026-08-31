import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SaveRecordInput } from "../shared/types";
import { isPairedGeumcheonAttemptIdentity } from "../shared/nas/protocol";
import { isCanonicalAiAttemptV1 } from "../shared/utils/geumcheonAiAttempt";

export type ActiveAttemptCheckpointV1 = {
  schemaVersion: 1;
  eventProfileId: string;
  variant: "ai" | "practice";
  recordId: string;
  updatedAt: string;
  input: SaveRecordInput;
};

export type ActiveAttemptCheckpointV2 = {
  schemaVersion: 2;
  eventProfileId: string;
  variant: "ai" | "practice";
  recordId: string;
  attemptId: string;
  recordedAt: string;
  updatedAt: string;
  input: SaveRecordInput;
};

export type ActiveAttemptEncryption = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type ActiveAttemptStore = {
  save(checkpoint: ActiveAttemptCheckpointV2): Promise<void>;
  read(): Promise<ActiveAttemptCheckpointV2 | null>;
  clear(): Promise<void>;
};

type ActiveAttemptStoreOptions = {
  checkpointPath: string;
  encryption: ActiveAttemptEncryption;
  eventProfileId: string;
  maxEncryptedBytes?: number;
  maxPlaintextBytes?: number;
};

export type ActiveAttemptStoreErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_CHECKPOINT"
  | "TOO_LARGE"
  | "ENCRYPTION_UNAVAILABLE"
  | "ENCRYPTION_FAILED"
  | "DECRYPTION_FAILED"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "CLEAR_FAILED";

export class ActiveAttemptStoreError extends Error {
  constructor(readonly code: ActiveAttemptStoreErrorCode) {
    super(`ACTIVE_ATTEMPT_${code}`);
    this.name = "ActiveAttemptStoreError";
  }
}

const DEFAULT_MAX_PLAINTEXT_BYTES = 256 * 1024;
const DEFAULT_MAX_ENCRYPTED_BYTES = 512 * 1024;

function fail(code: ActiveAttemptStoreErrorCode): never {
  throw new ActiveAttemptStoreError(code);
}

function requireEncryption(encryption: ActiveAttemptEncryption): void {
  try {
    if (encryption.isEncryptionAvailable()) return;
  } catch {
    // Safe error below deliberately omits the adapter''s message.
  }
  fail("ENCRYPTION_UNAVAILABLE");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isTuple(value: unknown, length: number, item: (entry: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length === length && value.every(item);
}

function isStageTextSelection(value: unknown, expectedStage: number): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["id", "catalogVersion", "stageNumber", "text"]) &&
    isString(value.id) &&
    isString(value.catalogVersion) &&
    value.stageNumber === expectedStage &&
    isString(value.text)
  );
}

function isFairnessStage(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "stageNumber",
      "textId",
      "catalogVersion",
      "targetText",
      "typedText",
      "userTimeMs",
      "typingUnits",
      "aiCpm",
      "result",
    ]) &&
    (value.stageNumber === 1 || value.stageNumber === 2 || value.stageNumber === 3) &&
    isString(value.textId) &&
    isString(value.catalogVersion) &&
    isString(value.targetText) &&
    isString(value.typedText) &&
    isNonNegativeNumber(value.userTimeMs) &&
    isNonNegativeNumber(value.typingUnits) &&
    isNonNegativeNumber(value.aiCpm) &&
    (value.result === "USER_WIN" || value.result === "AI_WIN" || value.result === "INTERRUPTED")
  );
}

function isFairness(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["catalogVersion", "totalUserTimeMs", "stages"]) &&
    isString(value.catalogVersion) &&
    isNonNegativeNumber(value.totalUserTimeMs) &&
    Array.isArray(value.stages) &&
    value.stages.length <= 3 &&
    value.stages.every(isFairnessStage) &&
    value.stages.every((stage, index) => stage.stageNumber === index + 1)
  );
}

function isAiDisplay(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "participantResultTimeMs",
      "aiResultTimeMs",
      "participantAvgCpm",
      "aiAvgCpm",
      "resultLabel",
      "participantProgressPercent",
      "aiProgressPercent",
      "duelTimeMs",
      "resultStage",
    ]) ||
    !isNumberOrNull(value.participantResultTimeMs) ||
    !isNumberOrNull(value.aiResultTimeMs) ||
    !isNumberOrNull(value.participantAvgCpm) ||
    !isNumberOrNull(value.aiAvgCpm) ||
    !isString(value.resultLabel)
  ) {
    return false;
  }
  for (const key of ["participantProgressPercent", "aiProgressPercent", "duelTimeMs"] as const) {
    if (key in value && !isNumberOrNull(value[key])) return false;
  }
  return !("resultStage" in value) || value.resultStage === null || value.resultStage === 1 || value.resultStage === 2 || value.resultStage === 3;
}

function isAi(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "status",
      "failedStage",
      "stageCpms",
      "stageTimesMs",
      "stageResults",
      "finalResult",
      "stageDiffsMs",
      "finalDiffMs",
      "display",
    ]) ||
    (value.status !== "SUCCESS" && value.status !== "FAILED") ||
    !isString(value.failedStage) ||
    !isTuple(value.stageCpms, 3, isNumberOrNull) ||
    !isTuple(value.stageTimesMs, 3, isNumberOrNull) ||
    !isTuple(value.stageDiffsMs, 3, isNumberOrNull) ||
    !isNumberOrNull(value.finalDiffMs)
  ) {
    return false;
  }
  const results = ["", "USER_WIN", "AI_WIN"];
  if (!isTuple(value.stageResults, 3, (entry) => results.includes(entry as string))) return false;
  if (!results.includes(value.finalResult as string)) return false;
  return !("display" in value) || isAiDisplay(value.display);
}

function isInterruption(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["action", "resultStage", "participantProgressPercent", "stageCharCounts", "totalTypingUnits"]) &&
    (value.action === "home" || value.action === "retry" || value.action === "exit") &&
    isFiniteNumber(value.resultStage) &&
    value.resultStage >= 1 &&
    value.resultStage <= 3 &&
    isFiniteNumber(value.participantProgressPercent) &&
    value.participantProgressPercent >= 0 &&
    value.participantProgressPercent <= 100 &&
    isTuple(value.stageCharCounts, 3, isNonNegativeNumber) &&
    isNonNegativeNumber(value.totalTypingUnits)
  );
}

function isSaveRecordInput(value: unknown): value is SaveRecordInput {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "participant_name",
      "phone_part1",
      "phone_part2",
      "phone_part3",
      "birth_year",
      "birth_month",
      "birth_day",
      "privacy_agreed",
      "privacy_agreed_at",
      "stageTexts",
      "stageTextSelections",
      "stageTimesMs",
      "fairness",
      "canonicalAttempt",
      "game_mode",
      "final_accuracy",
      "ai",
      "is_test",
      "is_debug",
      "debug_mode_type",
      "memo",
      "interruption",
    ]) ||
    !isString(value.participant_name) ||
    !isString(value.phone_part1) ||
    !isString(value.phone_part2) ||
    !isString(value.phone_part3) ||
    !isString(value.birth_year) ||
    !isString(value.birth_month) ||
    !isString(value.birth_day) ||
    typeof value.privacy_agreed !== "boolean" ||
    !isString(value.privacy_agreed_at) ||
    !isTuple(value.stageTexts, 3, isString) ||
    !isTuple(value.stageTimesMs, 3, isNonNegativeNumber)
  ) {
    return false;
  }
  if (
    "stageTextSelections" in value &&
    !(
      Array.isArray(value.stageTextSelections) &&
      value.stageTextSelections.length === 3 &&
      value.stageTextSelections.every((entry, index) => isStageTextSelection(entry, index + 1))
    )
  ) {
    return false;
  }
  if ("fairness" in value && !isFairness(value.fairness)) return false;
  if ("canonicalAttempt" in value && !isCanonicalAiAttemptV1(value.canonicalAttempt)) return false;
  if ("game_mode" in value && value.game_mode !== "normal" && value.game_mode !== "ai_challenge") return false;
  if ("final_accuracy" in value && (!isFiniteNumber(value.final_accuracy) || value.final_accuracy < 0 || value.final_accuracy > 100)) return false;
  if ("ai" in value && !isAi(value.ai)) return false;
  if ("is_test" in value && typeof value.is_test !== "boolean") return false;
  if ("is_debug" in value && typeof value.is_debug !== "boolean") return false;
  if (
    "debug_mode_type" in value &&
    value.debug_mode_type !== "" &&
    value.debug_mode_type !== "normal_typing_debug" &&
    value.debug_mode_type !== "ai_challenge_debug"
  ) {
    return false;
  }
  if ("memo" in value && !isString(value.memo)) return false;
  return !("interruption" in value) || isInterruption(value.interruption);
}

function isCheckpointV1(value: unknown, eventProfileId: string): value is ActiveAttemptCheckpointV1 {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["schemaVersion", "eventProfileId", "variant", "recordId", "updatedAt", "input"]) &&
    value.schemaVersion === 1 &&
    value.eventProfileId === eventProfileId &&
    (value.variant === "ai" || value.variant === "practice") &&
    isString(value.recordId) &&
    value.recordId.length > 0 &&
    value.recordId.length <= 200 &&
    isString(value.updatedAt) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isSaveRecordInput(value.input)
  );
}

function isCheckpointV2(value: unknown, eventProfileId: string): value is ActiveAttemptCheckpointV2 {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "eventProfileId",
      "variant",
      "recordId",
      "attemptId",
      "recordedAt",
      "updatedAt",
      "input",
    ]) &&
    value.schemaVersion === 2 &&
    value.eventProfileId === eventProfileId &&
    (value.variant === "ai" || value.variant === "practice") &&
    isString(value.recordId) &&
    value.recordId.length > 0 &&
    value.recordId.length <= 200 &&
    isPairedGeumcheonAttemptIdentity(value.recordId, value.attemptId) &&
    isIsoTimestamp(value.recordedAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isSaveRecordInput(value.input)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    isString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function upgradeCheckpointV1(
  checkpoint: ActiveAttemptCheckpointV1,
): ActiveAttemptCheckpointV2 | null {
  const match = /^gsc26-pc(?:0[1-9]|10)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
    checkpoint.recordId,
  );
  if (match == null) return null;
  return {
    ...checkpoint,
    schemaVersion: 2,
    attemptId: `gsc26-attempt-${match[1]}`,
    recordedAt: checkpoint.updatedAt,
  };
}

export function createActiveAttemptStore(options: ActiveAttemptStoreOptions): ActiveAttemptStore {
  const {
    checkpointPath,
    encryption,
    eventProfileId,
    maxEncryptedBytes = DEFAULT_MAX_ENCRYPTED_BYTES,
    maxPlaintextBytes = DEFAULT_MAX_PLAINTEXT_BYTES,
  } = options;
  if (
    !checkpointPath ||
    !eventProfileId ||
    !Number.isSafeInteger(maxEncryptedBytes) ||
    maxEncryptedBytes <= 0 ||
    !Number.isSafeInteger(maxPlaintextBytes) ||
    maxPlaintextBytes <= 0
  ) {
    fail("INVALID_OPTIONS");
  }

  return {
    async save(checkpoint) {
      if (!isCheckpointV2(checkpoint, eventProfileId)) fail("INVALID_CHECKPOINT");
      requireEncryption(encryption);
      const plaintext = JSON.stringify(checkpoint);
      if (Buffer.byteLength(plaintext, "utf8") > maxPlaintextBytes) fail("TOO_LARGE");
      let encrypted: Buffer;
      try {
        encrypted = encryption.encryptString(plaintext);
      } catch {
        fail("ENCRYPTION_FAILED");
      }
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > maxEncryptedBytes) {
        fail("TOO_LARGE");
      }
      const temporaryPath = `${checkpointPath}.tmp-${crypto.randomUUID()}`;
      try {
        await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
        const file = await fs.open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.rename(temporaryPath, checkpointPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        fail("WRITE_FAILED");
      }
    },

    async read() {
      let stat;
      try {
        stat = await fs.lstat(checkpointPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        fail("READ_FAILED");
      }
      if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_CHECKPOINT");
      if (stat.size === 0 || stat.size > maxEncryptedBytes) fail("TOO_LARGE");
      requireEncryption(encryption);
      let encrypted: Buffer;
      try {
        encrypted = await fs.readFile(checkpointPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        fail("READ_FAILED");
      }
      if (encrypted.length === 0 || encrypted.length > maxEncryptedBytes) fail("TOO_LARGE");
      let plaintext: string;
      try {
        plaintext = encryption.decryptString(encrypted);
      } catch {
        fail("DECRYPTION_FAILED");
      }
      if (Buffer.byteLength(plaintext, "utf8") > maxPlaintextBytes) fail("TOO_LARGE");
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        fail("INVALID_CHECKPOINT");
      }
      if (isCheckpointV2(parsed, eventProfileId)) return parsed;
      if (isCheckpointV1(parsed, eventProfileId)) {
        const upgraded = upgradeCheckpointV1(parsed);
        if (upgraded != null) return upgraded;
      }
      fail("INVALID_CHECKPOINT");
    },

    async clear() {
      try {
        await fs.unlink(checkpointPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CLEAR_FAILED");
      }
    },
  };
}
