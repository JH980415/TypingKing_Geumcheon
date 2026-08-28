import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionKind } from "../../shared/events/types";
import { canonicalStringify, isGeumcheonRecordId, type NasRecordEnvelopeV1 } from "../../shared/nas/protocol";
import { atomicWriteFile } from "./atomicFile";
import type { SafeStorageAdapter } from "./credentialStore";

export type NasOutboxItem = { kind: SessionKind; recordId: string; envelope: NasRecordEnvelopeV1 };
export type BlockedNasOutboxItem = NasOutboxItem & { reason: string };

export class EncryptedNasOutbox {
  constructor(private readonly options: { rootDir: string; safeStorage: SafeStorageAdapter }) {}

  async enqueue(kind: SessionKind, envelope: NasRecordEnvelopeV1): Promise<void> {
    this.assertAvailable();
    const recordId = recordIdOf(envelope);
    const destination = this.filePath(kind, "pending", recordId);
    const plaintext = canonicalStringify(envelope);
    if (await fileExists(destination)) {
      const existing = await this.decryptFile(destination);
      if (canonicalStringify(existing) !== plaintext) throw new Error("OUTBOX_RECORD_ID_CONFLICT");
      return;
    }
    await atomicWriteFile(destination, this.encrypt(plaintext));
  }

  async list(kind: SessionKind): Promise<NasOutboxItem[]> {
    const values = await this.listArea(kind, "pending");
    return values.map(({ recordId, value }) => ({ kind, recordId, envelope: value as NasRecordEnvelopeV1 }));
  }

  async remove(kind: SessionKind, recordId: string): Promise<void> {
    assertRecordId(recordId);
    await rm(this.filePath(kind, "pending", recordId), { force: true });
  }

  async block(kind: SessionKind, recordId: string, reason: string): Promise<void> {
    assertRecordId(recordId);
    if (!/^HTTP_(?:409|413|422)$/.test(reason)) throw new Error("OUTBOX_BLOCK_REASON_INVALID");
    const source = this.filePath(kind, "pending", recordId);
    const envelope = await this.decryptFile(source) as NasRecordEnvelopeV1;
    await atomicWriteFile(this.filePath(kind, "blocked", recordId), this.encrypt(canonicalStringify({ reason, envelope })));
    await rm(source);
  }

  async listBlocked(kind: SessionKind): Promise<BlockedNasOutboxItem[]> {
    const values = await this.listArea(kind, "blocked");
    return values.map(({ recordId, value }) => {
      if (!isObject(value) || typeof value.reason !== "string" || !isObject(value.envelope)) throw new Error("OUTBOX_FILE_INVALID");
      return { kind, recordId, reason: value.reason, envelope: value.envelope as NasRecordEnvelopeV1 };
    });
  }

  private async listArea(kind: SessionKind, area: "pending" | "blocked"): Promise<Array<{ recordId: string; value: unknown }>> {
    this.assertAvailable();
    const directory = path.join(this.options.rootDir, kind, area);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw new Error("OUTBOX_READ_FAILED");
    }
    const result: Array<{ recordId: string; value: unknown }> = [];
    for (const name of names.filter((value) => value.endsWith(".bin")).sort()) {
      const recordId = name.slice(0, -4);
      assertRecordId(recordId);
      result.push({ recordId, value: await this.decryptFile(path.join(directory, name)) });
    }
    return result;
  }

  private async decryptFile(filePath: string): Promise<unknown> {
    this.assertAvailable();
    try {
      if (!(await stat(filePath)).isFile()) throw new Error("OUTBOX_FILE_INVALID");
      return JSON.parse(this.options.safeStorage.decryptString(await readFile(filePath))) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message === "OUTBOX_FILE_INVALID") throw error;
      throw new Error("OUTBOX_DECRYPT_FAILED");
    }
  }

  private encrypt(plaintext: string): Buffer {
    try {
      return this.options.safeStorage.encryptString(plaintext);
    } catch {
      throw new Error("OUTBOX_ENCRYPT_FAILED");
    }
  }

  private filePath(kind: SessionKind, area: "pending" | "blocked", recordId: string): string {
    return path.join(this.options.rootDir, kind, area, `${recordId}.bin`);
  }

  private assertAvailable(): void {
    if (!this.options.safeStorage.isEncryptionAvailable()) throw new Error("SAFE_STORAGE_UNAVAILABLE");
  }
}

function recordIdOf(envelope: NasRecordEnvelopeV1): string {
  const candidate = envelope as unknown as { row?: { record_id?: unknown } };
  assertRecordId(candidate.row?.record_id);
  return candidate.row.record_id;
}

function assertRecordId(value: unknown): asserts value is string {
  if (!isGeumcheonRecordId(value)) throw new Error("OUTBOX_RECORD_ID_INVALID");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw new Error("OUTBOX_READ_FAILED");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
