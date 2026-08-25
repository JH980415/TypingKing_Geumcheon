import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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

export class RecordStore {
  readonly #dataRoot: string;
  readonly #atomicHooks: AtomicStoreHooks;

  constructor(options: { dataRoot: string; atomicHooks?: AtomicStoreHooks }) {
    this.#dataRoot = resolve(options.dataRoot);
    this.#atomicHooks = options.atomicHooks ?? {};
  }

  async put(record: StoredNasRecordV1): Promise<RecordPutResult> {
    const targetPath = await this.targetPath(record);
    const bytes = Buffer.from(canonicalStringify(record), "utf8");
    try {
      await writeFileNoReplaceAtomic(targetPath, bytes, this.#atomicHooks);
      return acknowledgement("stored", record, sha256(bytes));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return this.existingAcknowledgement(targetPath, record);
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
    const incomingDirectory = resolve(this.#dataRoot, ...segments);
    if (!inside(this.#dataRoot, incomingDirectory)) throw new Error("STORAGE_PATH_INVALID");
    await mkdir(incomingDirectory, { recursive: true, mode: 0o700 });
    const targetPath = resolve(incomingDirectory, `${record.record.record_id}.json`);
    if (dirname(targetPath) !== incomingDirectory) throw new Error("STORAGE_PATH_INVALID");
    return targetPath;
  }

  async existingAcknowledgement(targetPath: string, record: StoredNasRecordV1): Promise<RecordPutResult> {
    let bytes: Buffer;
    let existing: unknown;
    try {
      bytes = await readFile(targetPath);
      if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("invalid size");
      existing = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("STORAGE_CORRUPT");
    }
    if (!isStoredRecord(existing)) throw new Error("STORAGE_CORRUPT");
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

function isStoredRecord(value: unknown): value is Pick<StoredNasRecordV1, "payload_sha256" | "record"> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { payload_sha256?: unknown; record?: { received_at?: unknown } };
  return typeof candidate.payload_sha256 === "string" && /^[0-9a-f]{64}$/.test(candidate.payload_sha256)
    && candidate.record != null && typeof candidate.record === "object" && typeof candidate.record.received_at === "string";
}
