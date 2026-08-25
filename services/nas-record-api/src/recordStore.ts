import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { canonicalStringify, isGeumcheonRecordId } from "../../../shared/nas/protocol.js";
import type { StoredNasRecordV1 } from "./recordSchema.js";
import { type AtomicStoreHooks, verifyWritableDirectory, writeFileNoReplaceAtomic } from "./atomicStore.js";

export type RecordPutResult = {
  disposition: "stored" | "duplicate";
  recordId: string;
  payloadSha256: string;
  storedSha256: string;
  receivedAt: string;
};

export class StorageError extends Error {
  readonly code: "STORAGE_CORRUPT" | "STORAGE_PATH_SUBSTITUTION" | "STORAGE_UNAVAILABLE";

  constructor(code: StorageError["code"]) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}

export class RecordStore {
  readonly #dataRoot: string;
  readonly #atomicHooks: AtomicStoreHooks;

  constructor(options: { dataRoot: string; atomicHooks?: AtomicStoreHooks }) {
    this.#dataRoot = resolve(options.dataRoot);
    this.#atomicHooks = options.atomicHooks ?? {};
  }

  async put(record: StoredNasRecordV1): Promise<RecordPutResult> {
    try {
      const targetPath = await this.targetPath(record);
      const bytes = Buffer.from(canonicalStringify(record), "utf8");
      await writeFileNoReplaceAtomic(targetPath, bytes, this.#atomicHooks);
      return acknowledgement("stored", record, sha256(bytes));
    } catch (error) {
      if (isAlreadyExists(error)) {
        const targetPath = await this.targetPath(record);
        return this.existingAcknowledgement(targetPath, record);
      }
      throw storageError(error);
    }
  }

  async ready(): Promise<boolean> {
    return verifyWritableDirectory(this.#dataRoot);
  }

  async targetPath(record: StoredNasRecordV1): Promise<string> {
    if (!isGeumcheonRecordId(record.record.record_id)) throw new Error("RECORD_ID_INVALID");
    const segments = record.session.kind === "official"
      ? ["기록저장", `${record.session.day_no}일차`, `${record.session.round_no}회차`, "incoming", "ai"]
      : ["기록저장", "연습회차", "incoming", "ai"];
    try {
      const dataRoot = await realpath(this.#dataRoot);
      const incomingDirectory = resolve(dataRoot, ...segments);
      if (!inside(dataRoot, incomingDirectory)) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
      await createCanonicalDirectoryChain(dataRoot, segments);
      await assertCanonicalDirectoryChain(dataRoot, segments, incomingDirectory);
      const targetPath = resolve(incomingDirectory, `${record.record.record_id}.json`);
      if (dirname(targetPath) !== incomingDirectory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
      return targetPath;
    } catch (error) {
      throw storageError(error);
    }
  }

  async existingAcknowledgement(targetPath: string, record: StoredNasRecordV1): Promise<RecordPutResult> {
    let bytes: Buffer;
    let existing: unknown;
    try {
      bytes = await readFile(targetPath);
      if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("invalid size");
      existing = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (isFilesystemError(error)) throw new StorageError("STORAGE_UNAVAILABLE");
      throw new StorageError("STORAGE_CORRUPT");
    }
    if (!isCompleteStoredRecord(existing, record)) throw new StorageError("STORAGE_CORRUPT");
    if (existing.payload_sha256 !== record.payload_sha256) throw new Error("IDEMPOTENCY_CONFLICT");
    return {
      disposition: "duplicate",
      recordId: record.record.record_id,
      payloadSha256: record.payload_sha256,
      storedSha256: sha256(bytes),
      receivedAt: existing.record.received_at,
    };
  }
}

async function createCanonicalDirectoryChain(dataRoot: string, segments: readonly string[]): Promise<void> {
  let current = dataRoot;
  for (const segment of segments) {
    const next = resolve(current, segment);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      stat = await lstat(next);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    const canonical = await realpath(next);
    if (canonical !== next || !inside(dataRoot, canonical)) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    current = next;
  }
}

async function assertCanonicalDirectoryChain(dataRoot: string, segments: readonly string[], incomingDirectory: string): Promise<void> {
  let current = dataRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
  }
  const canonicalIncoming = await realpath(incomingDirectory);
  if (canonicalIncoming !== incomingDirectory || !inside(dataRoot, canonicalIncoming)) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
}

function acknowledgement(disposition: RecordPutResult["disposition"], record: StoredNasRecordV1, storedSha256: string): RecordPutResult {
  return { disposition, recordId: record.record.record_id, payloadSha256: record.payload_sha256, storedSha256, receivedAt: record.record.received_at };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !path.includes("..\\") && !path.includes("../");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error != null && /^E[A-Z0-9_]+$/.test(String((error as NodeJS.ErrnoException).code ?? ""));
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function storageError(error: unknown): Error {
  if (error instanceof StorageError || error instanceof Error && /^(?:RECORD_ID_INVALID|IDEMPOTENCY_CONFLICT)$/.test(error.message)) return error;
  return isFilesystemError(error) ? new StorageError("STORAGE_UNAVAILABLE") : error instanceof Error ? error : new StorageError("STORAGE_UNAVAILABLE");
}

function isCompleteStoredRecord(value: unknown, expected: StoredNasRecordV1): value is Pick<StoredNasRecordV1, "payload_sha256" | "record"> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["schema_version", "event_id", "session", "payload_sha256", "record"]) || candidate.schema_version !== 1 || candidate.event_id !== expected.event_id) return false;
  if (!sha(candidate.payload_sha256) || !sameSession(candidate.session, expected.session)) return false;
  const record = candidate.record;
  if (!plainObject(record) || !exactKeys(record, ["record_id", "created_at", "completed_at", "participant", "participant_key", "status", "stages", "app_version", "is_test", "is_debug", "debug_mode_type", "interruption_action", "authenticated_device_id", "total_typing_units", "total_user_time_ms", "effective_cpm_numerator", "effective_cpm_denominator", "display_cpm", "received_at"], ["interruption_action"])) return false;
  if (record.record_id !== expected.record.record_id || !isoFields(record, ["created_at", "completed_at", "received_at"]) || !sha(record.participant_key) || typeof record.app_version !== "string" || typeof record.authenticated_device_id !== "string") return false;
  if (typeof record.is_test !== "boolean" || typeof record.is_debug !== "boolean" || !["", "normal_typing_debug", "ai_challenge_debug"].includes(String(record.debug_mode_type))) return false;
  if (!Number.isSafeInteger(record.total_typing_units) || !Number.isSafeInteger(record.total_user_time_ms) || !Number.isSafeInteger(record.effective_cpm_numerator) || !Number.isSafeInteger(record.effective_cpm_denominator) || !Number.isSafeInteger(record.display_cpm)) return false;
  if (!plainObject(record.participant) || !exactKeys(record.participant, ["name", "phone", "phone_masked", "birthdate", "birthdate_masked", "privacy_agreed", "privacy_agreed_at"]) || record.participant.privacy_agreed !== true || !isoFields(record.participant, ["privacy_agreed_at"])) return false;
  return Array.isArray(record.stages) && record.stages.length >= 1 && record.stages.length <= 3 && record.stages.every(isStoredStage);
}

function isStoredStage(value: unknown): boolean {
  return plainObject(value) && exactKeys(value, ["stage_no", "text_id", "catalog_version", "target_text", "typed_text", "user_time_ms", "ai_cpm", "result", "typing_units"])
    && Number.isSafeInteger(value.stage_no) && typeof value.text_id === "string" && typeof value.catalog_version === "string" && typeof value.target_text === "string" && typeof value.typed_text === "string"
    && Number.isSafeInteger(value.user_time_ms) && Number.isSafeInteger(value.ai_cpm) && Number.isSafeInteger(value.typing_units) && ["USER_WIN", "AI_WIN", "INTERRUPTED"].includes(String(value.result));
}

function sameSession(value: unknown, expected: StoredNasRecordV1["session"]): boolean {
  return plainObject(value) && canonicalStringify(value) === canonicalStringify(expected);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => optional.includes(key) || key in value);
}

function isoFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && Number.isFinite(Date.parse(value[key] as string)));
}

function sha(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
