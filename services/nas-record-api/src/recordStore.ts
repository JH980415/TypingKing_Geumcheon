import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { RECORD_HEADERS } from "../../../shared/constants/defaults.js";
import type {
  NasAdminActionV1,
  NasSessionV1,
} from "../../../shared/nas/protocol.js";
import {
  GEUMCHEON_NAS_EVENT_ID,
  canonicalStringify,
  isGeumcheonRecordId,
} from "../../../shared/nas/protocol.js";
import type { RecordRow } from "../../../shared/types/index.js";
import {
  verifyWritableDirectory,
  writeFileNoReplaceAtomic,
  type AtomicStoreHooks,
} from "./atomicStore.js";
import type { StoredNasRecordV1 } from "./recordSchema.js";

const ACTION_ID = /^gsc26-action-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STORED_BYTES = 128 * 1024;

export type RecordPutResult = {
  disposition: "stored" | "duplicate";
  recordId: string;
  payloadSha256: string;
  storedSha256: string;
  receivedAt: string;
};

export type AdminActionPutResult = {
  disposition: "stored" | "duplicate";
  actionId: string;
  receivedAt: string;
};

export class StorageError extends Error {
  constructor(
    readonly code:
      | "STORAGE_CORRUPT"
      | "STORAGE_PATH_SUBSTITUTION"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "StorageError";
  }
}

export class RecordStore {
  readonly #dataRoot: string;
  readonly #atomicHooks: AtomicStoreHooks;

  constructor(options: { dataRoot: string; atomicHooks?: AtomicStoreHooks }) {
    this.#dataRoot = resolve(options.dataRoot);
    this.#atomicHooks = options.atomicHooks ?? {};
  }

  async ready(): Promise<boolean> {
    try {
      const directory = await this.ensureDirectory(["기록저장"]);
      return verifyWritableDirectory(directory);
    } catch {
      return false;
    }
  }

  async put(record: StoredNasRecordV1): Promise<RecordPutResult> {
    const targetPath = await this.recordTarget(record.session, record.row.record_id);
    const bytes = Buffer.from(canonicalStringify(record.row), "utf8");
    try {
      await writeFileNoReplaceAtomic(targetPath, bytes, this.#atomicHooks);
      return recordAcknowledgement("stored", record, sha256(bytes), record.received_at);
    } catch (error) {
      if (isAlreadyExists(error)) {
        return this.existingRecordAcknowledgement(targetPath, record);
      }
      throw storageError(error);
    }
  }

  async list(session: NasSessionV1): Promise<RecordRow[]> {
    const directory = await this.recordDirectory(session);
    let names: string[];
    try {
      names = (await readdir(directory))
        .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
        .sort();
    } catch (error) {
      throw storageError(error);
    }

    const rows: RecordRow[] = [];
    for (const name of names) {
      const targetPath = resolve(directory, name);
      if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
      rows.push(await readStoredRow(targetPath));
    }
    return rows.sort((left, right) =>
      `${left.completed_at}_${left.record_id}`.localeCompare(
        `${right.completed_at}_${right.record_id}`,
      ));
  }

  async putAdminAction(action: NasAdminActionV1): Promise<AdminActionPutResult> {
    validateAdminAction(action);
    const directory = await this.adminDirectory(action.session);
    const targetPath = resolve(directory, `${action.action_id}.json`);
    if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    const bytes = Buffer.from(canonicalStringify(action), "utf8");
    try {
      await writeFileNoReplaceAtomic(targetPath, bytes, this.#atomicHooks);
      return {
        disposition: "stored",
        actionId: action.action_id,
        receivedAt: action.created_at,
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw storageError(error);
      const existing = await readBoundedJson(targetPath);
      if (canonicalStringify(existing) !== canonicalStringify(action)) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return {
        disposition: "duplicate",
        actionId: action.action_id,
        receivedAt: action.created_at,
      };
    }
  }

  async listEffective(session: NasSessionV1): Promise<RecordRow[]> {
    const originals = await this.list(session);
    const visible = new Map(originals.map((row) => [row.record_id, { ...row }]));
    const hidden = new Map<string, RecordRow>();

    for (const action of await this.listAdminActions(session)) {
      if (action.action_type === "reset_session") {
        visible.clear();
        hidden.clear();
        continue;
      }

      const targetId = action.target_record_id;
      if (action.action_type === "edit") {
        const current = visible.get(targetId) ?? hidden.get(targetId);
        if (current == null) continue;
        const edited: RecordRow = {
          ...current,
          ...action.changes,
          record_id: current.record_id,
          original_record_id: current.original_record_id || current.record_id,
          is_admin_edited: "true",
        };
        if (visible.has(targetId)) visible.set(targetId, edited);
        if (hidden.has(targetId)) hidden.set(targetId, edited);
        continue;
      }

      if (action.hidden) {
        const current = visible.get(targetId);
        if (current != null) hidden.set(targetId, current);
        visible.delete(targetId);
      } else {
        const current = hidden.get(targetId)
          ?? originals.find((row) => row.record_id === targetId);
        if (current != null) visible.set(targetId, { ...current });
        hidden.delete(targetId);
      }
    }

    return [...visible.values()];
  }

  private async existingRecordAcknowledgement(
    targetPath: string,
    record: StoredNasRecordV1,
  ): Promise<RecordPutResult> {
    const bytes = await readBoundedBytes(targetPath);
    let existing: unknown;
    try {
      existing = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new StorageError("STORAGE_CORRUPT");
    }
    if (!isCompleteRecordRow(existing)) throw new StorageError("STORAGE_CORRUPT");
    if (canonicalStringify(existing) !== canonicalStringify(record.row)) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
    const file = await stat(targetPath).catch((error) => {
      throw storageError(error);
    });
    return recordAcknowledgement(
      "duplicate",
      record,
      sha256(bytes),
      file.mtime.toISOString(),
    );
  }

  private async recordTarget(session: NasSessionV1, recordId: string): Promise<string> {
    if (!isGeumcheonRecordId(recordId)) throw new Error("RECORD_ID_INVALID");
    const directory = await this.recordDirectory(session);
    const targetPath = resolve(directory, `${recordId}.json`);
    if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    return targetPath;
  }

  private async recordDirectory(session: NasSessionV1): Promise<string> {
    return this.ensureDirectory(session.kind === "official"
      ? ["기록저장", `${session.day_no}일차`, `${session.round_no}회차`, "incoming", "ai"]
      : ["기록저장", "연습회차", "incoming", "ai"]);
  }

  private async adminDirectory(session: NasSessionV1): Promise<string> {
    return this.ensureDirectory(session.kind === "official"
      ? ["기록저장", `${session.day_no}일차`, `${session.round_no}회차`, "admin_actions"]
      : ["기록저장", "연습회차", "admin_actions"]);
  }

  private async listAdminActions(session: NasSessionV1): Promise<NasAdminActionV1[]> {
    const directory = await this.adminDirectory(session);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .sort();
    const actions: NasAdminActionV1[] = [];
    for (const name of names) {
      const targetPath = resolve(directory, name);
      if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
      const action = await readBoundedJson(targetPath);
      validateAdminAction(action);
      if (!sameSession(action.session, session)) {
        throw new StorageError("STORAGE_CORRUPT");
      }
      actions.push(action);
    }
    return actions.sort((left, right) =>
      `${left.created_at}_${left.action_id}`.localeCompare(
        `${right.created_at}_${right.action_id}`,
      ));
  }

  private async ensureDirectory(segments: readonly string[]): Promise<string> {
    try {
      await mkdir(this.#dataRoot, { recursive: true, mode: 0o700 });
      const canonicalRoot = await realpath(this.#dataRoot);
      let current = canonicalRoot;
      for (const segment of segments) {
        if (!/^[^\\/]+$/.test(segment) || segment === "." || segment === "..") {
          throw new StorageError("STORAGE_PATH_SUBSTITUTION");
        }
        const next = join(current, segment);
        try {
          const info = await lstat(next);
          if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new StorageError("STORAGE_PATH_SUBSTITUTION");
          }
        } catch (error) {
          if (!isMissingPath(error)) throw error;
          await mkdir(next, { mode: 0o700 }).catch((mkdirError) => {
            if (!isAlreadyExists(mkdirError)) throw mkdirError;
          });
          const created = await lstat(next);
          if (created.isSymbolicLink() || !created.isDirectory()) {
            throw new StorageError("STORAGE_PATH_SUBSTITUTION");
          }
        }
        const canonicalNext = await realpath(next);
        if (!inside(canonicalRoot, canonicalNext)) {
          throw new StorageError("STORAGE_PATH_SUBSTITUTION");
        }
        current = canonicalNext;
      }
      return current;
    } catch (error) {
      throw storageError(error);
    }
  }
}

function recordAcknowledgement(
  disposition: "stored" | "duplicate",
  record: StoredNasRecordV1,
  storedSha256: string,
  receivedAt: string,
): RecordPutResult {
  return {
    disposition,
    recordId: record.row.record_id,
    payloadSha256: record.payload_sha256,
    storedSha256,
    receivedAt,
  };
}

async function readStoredRow(targetPath: string): Promise<RecordRow> {
  const value = await readBoundedJson(targetPath);
  if (!isCompleteRecordRow(value)) throw new StorageError("STORAGE_CORRUPT");
  return value;
}

async function readBoundedJson(targetPath: string): Promise<unknown> {
  const bytes = await readBoundedBytes(targetPath);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new StorageError("STORAGE_CORRUPT");
  }
}

async function readBoundedBytes(targetPath: string): Promise<Buffer> {
  try {
    const bytes = await readFile(targetPath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_STORED_BYTES) {
      throw new StorageError("STORAGE_CORRUPT");
    }
    return bytes;
  } catch (error) {
    throw storageError(error);
  }
}

function isCompleteRecordRow(value: unknown): value is RecordRow {
  if (!plainObject(value) || !isGeumcheonRecordId(value.record_id)) return false;
  return RECORD_HEADERS.every((key) => typeof value[key] === "string");
}

function validateAdminAction(value: unknown): asserts value is NasAdminActionV1 {
  if (!plainObject(value)) throw new Error("ADMIN_ACTION_INVALID");
  if (
    value.schema_version !== 1
    || value.event_id !== GEUMCHEON_NAS_EVENT_ID
    || typeof value.action_id !== "string"
    || !ACTION_ID.test(value.action_id)
    || typeof value.created_at !== "string"
    || Number.isNaN(Date.parse(value.created_at))
    || typeof value.admin_name !== "string"
    || value.admin_name.trim().length === 0
    || !validSession(value.session)
  ) {
    throw new Error("ADMIN_ACTION_INVALID");
  }

  if (value.action_type === "reset_session") {
    exactKeys(value, [
      "schema_version",
      "event_id",
      "session",
      "action_id",
      "created_at",
      "admin_name",
      "action_type",
    ], "ADMIN_ACTION_INVALID");
    return;
  }

  if (!isGeumcheonRecordId(value.target_record_id)) {
    throw new Error("ADMIN_TARGET_INVALID");
  }
  if (value.action_type === "hide") {
    exactKeys(value, [
      "schema_version",
      "event_id",
      "session",
      "action_id",
      "created_at",
      "admin_name",
      "action_type",
      "target_record_id",
      "hidden",
    ], "ADMIN_ACTION_INVALID");
    if (typeof value.hidden !== "boolean") throw new Error("ADMIN_ACTION_INVALID");
    return;
  }

  if (value.action_type === "edit") {
    exactKeys(value, [
      "schema_version",
      "event_id",
      "session",
      "action_id",
      "created_at",
      "admin_name",
      "action_type",
      "target_record_id",
      "changes",
    ], "ADMIN_ACTION_INVALID");
    if (!plainObject(value.changes) || Object.keys(value.changes).length === 0) {
      throw new Error("ADMIN_CHANGES_INVALID");
    }
    for (const [key, changed] of Object.entries(value.changes)) {
      if (key === "record_id" || !RECORD_HEADERS.includes(key as (typeof RECORD_HEADERS)[number])) {
        throw new Error("ADMIN_EDIT_FIELD_FORBIDDEN");
      }
      if (typeof changed !== "string") throw new Error("ADMIN_CHANGES_INVALID");
    }
    return;
  }

  throw new Error("ADMIN_ACTION_INVALID");
}

function validSession(value: unknown): value is NasSessionV1 {
  if (!plainObject(value) || typeof value.session_id !== "string" || value.session_id === "") {
    return false;
  }
  if (value.kind === "practice") {
    return exactKeysBoolean(value, ["kind", "session_id"]);
  }
  return value.kind === "official"
    && Number.isInteger(value.day_no)
    && Number.isInteger(value.round_no)
    && exactKeysBoolean(value, ["kind", "session_id", "day_no", "round_no"]);
}

function sameSession(left: NasSessionV1, right: NasSessionV1): boolean {
  return left.kind === right.kind
    && left.session_id === right.session_id
    && (left.kind === "practice"
      || right.kind === "official"
        && left.day_no === right.day_no
        && left.round_no === right.round_no);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (!exactKeysBoolean(value, keys)) throw new Error(code);
}

function exactKeysBoolean(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error != null
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error != null
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error != null
    && /^E[A-Z0-9_]+$/.test(String((error as NodeJS.ErrnoException).code ?? ""));
}

function storageError(error: unknown): Error {
  if (
    error instanceof StorageError
    || error instanceof Error
      && /^(?:RECORD_ID_INVALID|IDEMPOTENCY_CONFLICT|ADMIN_[A-Z_]+)$/.test(error.message)
  ) {
    return error;
  }
  if (isFilesystemError(error)) return new StorageError("STORAGE_UNAVAILABLE");
  return error instanceof Error ? error : new StorageError("STORAGE_UNAVAILABLE");
}
