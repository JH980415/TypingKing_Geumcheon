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
  NasRecordEnvelopeV1,
  NasSessionV1,
} from "../../../shared/nas/protocol.js";
import {
  GEUMCHEON_NAS_EVENT_ID,
  canonicalStringify,
  isGeumcheonRecordId,
  isPairedGeumcheonAttemptIdentity,
} from "../../../shared/nas/protocol.js";
import type {
  CanonicalAiContradictionCode,
  RecordRow,
} from "../../../shared/types/index.js";
import {
  isCanonicalAiAttemptPubliclyRankable,
  isCanonicalAiAttemptV1,
} from "../../../shared/utils/geumcheonAiAttempt.js";
import {
  compareCanonicalAiDisplayOrder,
  compareLegacyAiRecords,
} from "../../../shared/utils/ranking.js";
import {
  verifyWritableDirectory,
  writeFileNoReplaceAtomic,
  type AtomicStoreHooks,
} from "./atomicStore.js";
import type { StoredNasRecordV1 } from "./recordSchema.js";

const ACTION_ID = /^gsc26-action-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STORED_BYTES = 128 * 1024;
const CONTRADICTION_CODES = new Set<CanonicalAiContradictionCode>([
  "METRIC_NON_FINITE",
  "METRIC_NEGATIVE",
  "PROGRESS_OUT_OF_RANGE",
  "ASSIGNED_UNITS_INVALID",
  "CPM_UNDEFINED",
  "TOTALS_MISMATCH",
  "STAGE_PROGRESS_CONTRADICTION",
  "RESULT_PROGRESS_CONTRADICTION",
  "RESULT_TIMING_CONTRADICTION",
  "INTERRUPTION_REASON_MISMATCH",
  "IDENTITY_MISMATCH",
]);

export type RecordPutResult = {
  disposition: "stored" | "duplicate";
  recordId: string;
  payloadSha256: string;
  storedSha256: string;
  receivedAt: string;
};

export type QuarantinedNasRecordV1 = {
  schema_version: 1;
  quarantine_type: "contradiction";
  record_id: string;
  attempt_id: string;
  authenticated_device_id: string;
  received_at: string;
  payload_sha256: string;
  reason_code: CanonicalAiContradictionCode;
  envelope: NasRecordEnvelopeV1;
};

type RecordStorageClass = "accepted" | "contradiction";

type RecordIdClaimV1 = {
  schema_version: 1;
  record_id: string;
  authenticated_device_id: string;
  payload_sha256: string;
  storage_class: RecordStorageClass;
  reason_code: CanonicalAiContradictionCode | null;
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
    const existing = await this.existingRecordIfPresent(targetPath, record);
    if (existing != null) {
      await this.putRecordIdClaim(record, "accepted", null);
      return existing;
    }
    await this.assertTargetMissing(
      await this.quarantineTarget(record.session, record.row.record_id),
    );
    await this.putRecordIdClaim(record, "accepted", null);
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

  async putContradiction(
    record: StoredNasRecordV1,
    reasonCode: CanonicalAiContradictionCode,
  ): Promise<"stored" | "duplicate"> {
    if (!CONTRADICTION_CODES.has(reasonCode)) {
      throw new Error("QUARANTINE_REASON_INVALID");
    }
    const attempt = record.row.canonicalAttempt;
    if (attempt == null) throw new Error("CANONICAL_ATTEMPT_INVALID");
    const quarantined: QuarantinedNasRecordV1 = {
      schema_version: 1,
      quarantine_type: "contradiction",
      record_id: record.row.record_id,
      attempt_id: attempt.attemptId,
      authenticated_device_id: record.authenticated_device_id,
      received_at: record.received_at,
      payload_sha256: record.payload_sha256,
      reason_code: reasonCode,
      envelope: {
        schema_version: record.schema_version,
        event_id: record.event_id,
        session: record.session,
        row: record.row,
      },
    };
    const targetPath = await this.quarantineTarget(record.session, record.row.record_id);
    const existing = await this.existingQuarantineIfPresent(targetPath, quarantined);
    if (existing) {
      await this.putRecordIdClaim(record, "contradiction", reasonCode);
      return "duplicate";
    }
    await this.assertTargetMissing(
      await this.recordTarget(record.session, record.row.record_id),
    );
    await this.putRecordIdClaim(record, "contradiction", reasonCode);
    const bytes = Buffer.from(canonicalStringify(quarantined), "utf8");
    try {
      await writeFileNoReplaceAtomic(targetPath, bytes, this.#atomicHooks);
      return "stored";
    } catch (error) {
      if (!isAlreadyExists(error)) throw storageError(error);
      await this.existingQuarantineAcknowledgement(targetPath, quarantined);
      return "duplicate";
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
    return rows.sort(compareLeaderboardRecordOrder);
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

    return [...visible.values()]
      .filter(isEffectiveCanonicalRow)
      .sort(compareLeaderboardRecordOrder);
  }

  private async existingRecordIfPresent(
    targetPath: string,
    record: StoredNasRecordV1,
  ): Promise<RecordPutResult | undefined> {
    if (!await pathExists(targetPath)) return undefined;
    return this.existingRecordAcknowledgement(targetPath, record);
  }

  private async existingQuarantineIfPresent(
    targetPath: string,
    quarantined: QuarantinedNasRecordV1,
  ): Promise<boolean> {
    if (!await pathExists(targetPath)) return false;
    await this.existingQuarantineAcknowledgement(targetPath, quarantined);
    return true;
  }

  private async existingQuarantineAcknowledgement(
    targetPath: string,
    quarantined: QuarantinedNasRecordV1,
  ): Promise<void> {
    const existing = await readBoundedJson(targetPath);
    if (!isCompleteQuarantine(existing)) throw new StorageError("STORAGE_CORRUPT");
    if (!sameQuarantineSubmission(existing, quarantined)) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
  }

  private async assertTargetMissing(targetPath: string): Promise<void> {
    if (await pathExists(targetPath)) throw new Error("IDEMPOTENCY_CONFLICT");
  }

  private async putRecordIdClaim(
    record: StoredNasRecordV1,
    storageClass: RecordStorageClass,
    reasonCode: CanonicalAiContradictionCode | null,
  ): Promise<void> {
    const claim: RecordIdClaimV1 = {
      schema_version: 1,
      record_id: record.row.record_id,
      authenticated_device_id: record.authenticated_device_id,
      payload_sha256: record.payload_sha256,
      storage_class: storageClass,
      reason_code: reasonCode,
    };
    const targetPath = await this.idempotencyTarget(record.session, record.row.record_id);
    const bytes = Buffer.from(canonicalStringify(claim), "utf8");
    try {
      await writeFileNoReplaceAtomic(targetPath, bytes);
    } catch (error) {
      if (!isAlreadyExists(error)) throw storageError(error);
      const existing = await readBoundedJson(targetPath);
      if (!isCompleteRecordIdClaim(existing)) throw new StorageError("STORAGE_CORRUPT");
      if (!sameRecordIdClaim(existing, claim)) throw new Error("IDEMPOTENCY_CONFLICT");
    }
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

  private async quarantineTarget(session: NasSessionV1, recordId: string): Promise<string> {
    if (!isGeumcheonRecordId(recordId)) throw new Error("RECORD_ID_INVALID");
    const directory = await this.quarantineDirectory(session);
    const targetPath = resolve(directory, `${recordId}.json`);
    if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    return targetPath;
  }

  private async idempotencyTarget(session: NasSessionV1, recordId: string): Promise<string> {
    if (!isGeumcheonRecordId(recordId)) throw new Error("RECORD_ID_INVALID");
    const directory = await this.idempotencyDirectory(session);
    const targetPath = resolve(directory, recordId + ".claim");
    if (dirname(targetPath) !== directory) throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    return targetPath;
  }

  private async recordDirectory(session: NasSessionV1): Promise<string> {
    return this.ensureDirectory(session.kind === "official"
      ? ["기록저장", `${session.day_no}일차`, `${session.round_no}회차`, "incoming", "ai"]
      : ["기록저장", "연습회차", "incoming", "ai"]);
  }

  private async quarantineDirectory(session: NasSessionV1): Promise<string> {
    return this.ensureDirectory(session.kind === "official"
      ? ["기록저장", `${session.day_no}일차`, `${session.round_no}회차`, "quarantine", "contradiction"]
      : ["기록저장", "연습회차", "quarantine", "contradiction"]);
  }

  private async idempotencyDirectory(session: NasSessionV1): Promise<string> {
    return this.ensureDirectory(session.kind === "official"
      ? ["기록저장", String(session.day_no) + "일차", String(session.round_no) + "회차", "idempotency"]
      : ["기록저장", "연습회차", "idempotency"]);
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new StorageError("STORAGE_PATH_SUBSTITUTION");
    }
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw storageError(error);
  }
}

function isCompleteRecordRow(value: unknown): value is RecordRow {
  if (!plainObject(value) || !isGeumcheonRecordId(value.record_id)) return false;
  if (!RECORD_HEADERS.every((key) => typeof value[key] === "string")) return false;
  return value.canonicalAttempt === undefined
    || isCanonicalAiAttemptV1(value.canonicalAttempt);
}

function isCompleteQuarantine(value: unknown): value is QuarantinedNasRecordV1 {
  if (
    !plainObject(value)
    || !exactKeysBoolean(value, [
      "schema_version",
      "quarantine_type",
      "record_id",
      "attempt_id",
      "authenticated_device_id",
      "received_at",
      "payload_sha256",
      "reason_code",
      "envelope",
    ])
    || value.schema_version !== 1
    || value.quarantine_type !== "contradiction"
    || !isGeumcheonRecordId(value.record_id)
    || typeof value.attempt_id !== "string"
    || typeof value.authenticated_device_id !== "string"
    || typeof value.received_at !== "string"
    || Number.isNaN(Date.parse(value.received_at))
    || typeof value.payload_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.payload_sha256)
    || typeof value.reason_code !== "string"
    || !CONTRADICTION_CODES.has(value.reason_code as CanonicalAiContradictionCode)
    || !plainObject(value.envelope)
    || !exactKeysBoolean(value.envelope, ["schema_version", "event_id", "session", "row"])
    || value.envelope.schema_version !== 1
    || value.envelope.event_id !== GEUMCHEON_NAS_EVENT_ID
    || !validSession(value.envelope.session)
    || !isCompleteRecordRow(value.envelope.row)
    || value.envelope.row.record_id !== value.record_id
    || value.envelope.row.canonicalAttempt?.attemptId !== value.attempt_id
  ) {
    return false;
  }
  return true;
}

function sameQuarantineSubmission(
  left: QuarantinedNasRecordV1,
  right: QuarantinedNasRecordV1,
): boolean {
  return left.schema_version === right.schema_version
    && left.quarantine_type === right.quarantine_type
    && left.record_id === right.record_id
    && left.attempt_id === right.attempt_id
    && left.authenticated_device_id === right.authenticated_device_id
    && left.payload_sha256 === right.payload_sha256
    && left.reason_code === right.reason_code
    && canonicalStringify(left.envelope) === canonicalStringify(right.envelope);
}

function isCompleteRecordIdClaim(value: unknown): value is RecordIdClaimV1 {
  if (
    !plainObject(value)
    || !exactKeysBoolean(value, [
      "schema_version",
      "record_id",
      "authenticated_device_id",
      "payload_sha256",
      "storage_class",
      "reason_code",
    ])
    || value.schema_version !== 1
    || !isGeumcheonRecordId(value.record_id)
    || typeof value.authenticated_device_id !== "string"
    || typeof value.payload_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.payload_sha256)
    || (value.storage_class !== "accepted" && value.storage_class !== "contradiction")
  ) {
    return false;
  }
  return value.storage_class === "accepted"
    ? value.reason_code === null
    : typeof value.reason_code === "string"
      && CONTRADICTION_CODES.has(value.reason_code as CanonicalAiContradictionCode);
}

function sameRecordIdClaim(left: RecordIdClaimV1, right: RecordIdClaimV1): boolean {
  return left.schema_version === right.schema_version
    && left.record_id === right.record_id
    && left.authenticated_device_id === right.authenticated_device_id
    && left.payload_sha256 === right.payload_sha256
    && left.storage_class === right.storage_class
    && left.reason_code === right.reason_code;
}

function isEffectiveCanonicalRow(row: RecordRow): boolean {
  const attempt = row.canonicalAttempt;
  if (attempt === undefined) return true;
  if (!isCanonicalAiAttemptV1(attempt)) return false;
  const match = /^gsc26-(pc(?:0[1-9]|10))-[0-9a-f-]+$/.exec(row.record_id);
  if (match == null) return false;
  const expectedDeviceId = match[1].toUpperCase();
  if (
    !isPairedGeumcheonAttemptIdentity(row.record_id, attempt.attemptId)
    || !isCanonicalAiAttemptPubliclyRankable(attempt, {
      recordId: row.record_id,
      deviceId: expectedDeviceId,
    })
    || Number(row.result_stage) !== attempt.stageReached
  ) {
    return false;
  }
  if (attempt.result === "PARTICIPANT_WIN") {
    return row.ai_challenge_status === "SUCCESS"
      && row.final_vs_ai_result === "USER_WIN";
  }
  if (attempt.result === "GEUMNARAE_WIN") {
    return row.ai_challenge_status === "FAILED"
      && row.final_vs_ai_result === "AI_WIN";
  }
  const expectedMemo = attempt.interruptionReason === "HOME"
    ? "사용자 중단:메인화면"
    : attempt.interruptionReason === "RETRY"
      ? "사용자 중단:다시하기"
      : "사용자 중단:프로그램 종료";
  return row.ai_challenge_status === "FAILED" && row.memo === expectedMemo;
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

function compareLeaderboardRecordOrder(left: RecordRow, right: RecordRow): number {
  if (left.game_mode === "ai_challenge" && right.game_mode === "ai_challenge") {
    if (left.canonicalAttempt && right.canonicalAttempt) {
      return compareCanonicalAiDisplayOrder(left.canonicalAttempt, right.canonicalAttempt);
    }
    if (left.canonicalAttempt) return -1;
    if (right.canonicalAttempt) return 1;
    return compareLegacyAiRecords(left, right);
  }
  return `${left.completed_at}_${left.record_id}`.localeCompare(
    `${right.completed_at}_${right.record_id}`,
  );
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
