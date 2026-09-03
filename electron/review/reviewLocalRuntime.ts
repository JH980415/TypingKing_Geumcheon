import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { atomicWriteFile } from "../nas/atomicFile";
import type { RecordRow } from "../../shared/types";
import { compareRecords, sortRecords } from "../../shared/utils/ranking";

const REVIEW_MARKER = "geumcheon-2026-review" as const;
const REVIEW_RECORD_ID = /^review-r5-record-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVIEW_ATTEMPT_ID = /^review-r5-attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export type ReviewSession =
  | { kind: "official"; sessionId: string; dayNo: number; roundNo: number }
  | { kind: "practice"; sessionId: string };

export type ReviewAttemptIdentityPolicy = {
  isTrusted(recordId: unknown, attemptId: unknown): boolean;
};

export type ReviewLocalRuntime = {
  save(row: RecordRow): Promise<RecordRow>;
  list(): Promise<RecordRow[]>;
  best(): Promise<RecordRow[]>;
  edit(recordId: string, changes: Partial<RecordRow>): Promise<RecordRow>;
  hide(recordId: string): Promise<void>;
  reset(): Promise<void>;
  participantKeyFor(identity: { participantName: string; phoneFull: string; birthdate: string }): Promise<string>;
};

type ReviewRecordEnvelope = {
  schemaVersion: 1;
  reviewMarker: typeof REVIEW_MARKER;
  session: ReviewSession;
  hidden: boolean;
  row: RecordRow;
};

type ReviewLocalRuntimeOptions = {
  rootDir: string;
  role: "player" | "leaderboard";
  session: ReviewSession;
};

export const reviewAttemptIdentityPolicy: ReviewAttemptIdentityPolicy = {
  isTrusted(recordId, attemptId) {
    if (typeof recordId !== "string" || typeof attemptId !== "string") return false;
    const recordMatch = new RegExp(`^review-r5-record-(${UUID})$`).exec(recordId);
    return recordMatch != null && REVIEW_ATTEMPT_ID.test(attemptId) && attemptId === `review-r5-attempt-${recordMatch[1]}`;
  },
};

export function createReviewAttemptIdentity(uuid = crypto.randomUUID()): { recordId: string; attemptId: string } {
  const normalized = uuid.toLowerCase();
  if (!new RegExp(`^${UUID}$`).test(normalized)) throw new Error("REVIEW_ATTEMPT_ID_INVALID");
  return { recordId: `review-r5-record-${normalized}`, attemptId: `review-r5-attempt-${normalized}` };
}

export function createReviewLocalRuntime(options: ReviewLocalRuntimeOptions): ReviewLocalRuntime {
  assertOptions(options);
  const sessionRoot = path.join(options.rootDir, options.session.kind, options.session.sessionId);
  const recordDir = path.join(sessionRoot, "records");
  const mutationLock = path.join(sessionRoot, ".review-mutation");
  const saltPath = path.join(options.rootDir, ".review-state", "participant-key.salt");
  const saltLock = path.join(options.rootDir, ".review-state", ".participant-key");

  async function participantKeyFor(identity: { participantName: string; phoneFull: string; birthdate: string }): Promise<string> {
    if (!isIdentity(identity)) throw new Error("REVIEW_PARTICIPANT_INVALID");
    const salt = await readOrCreateSalt(saltPath, saltLock);
    return crypto
      .createHmac("sha256", salt)
      .update(`${normalizeIdentity(identity.participantName)}\u0000${normalizeIdentity(identity.phoneFull)}\u0000${normalizeIdentity(identity.birthdate)}`, "utf8")
      .digest("hex");
  }

  async function save(row: RecordRow): Promise<RecordRow> {
    const storedRow = { ...row, participantKey: await participantKeyFor({
      participantName: row.participant_name,
      phoneFull: row.phone_full,
      birthdate: row.birthdate,
    }) };
    assertReviewRow(storedRow);
    return withLock(mutationLock, async () => {
      const target = recordPath(recordDir, storedRow.record_id);
      const existing = await readEnvelopeIfPresent(target, options.session);
      if (existing != null) return { ...existing.row };
      await writeEnvelope(target, { schemaVersion: 1, reviewMarker: REVIEW_MARKER, session: options.session, hidden: false, row: storedRow });
      return { ...storedRow };
    });
  }

  async function list(): Promise<RecordRow[]> {
    const envelopes = await readEnvelopes(recordDir, options.session);
    return sortRecords(envelopes.filter((entry) => !entry.hidden).map((entry) => ({ ...entry.row })));
  }

  async function best(): Promise<RecordRow[]> {
    const grouped = new Map<string, RecordRow>();
    for (const row of await list()) {
      const participantKey = row.participantKey;
      if (typeof participantKey !== "string" || !/^[a-f0-9]{64}$/.test(participantKey)) {
        throw new Error("REVIEW_RECORD_CORRUPT");
      }
      const current = grouped.get(participantKey);
      if (current == null || compareRecords(row, current) < 0) grouped.set(participantKey, row);
    }
    return sortRecords([...grouped.values()]);
  }

  async function edit(recordId: string, changes: Partial<RecordRow>): Promise<RecordRow> {
    assertReviewRecordId(recordId);
    if (changes.record_id != null && changes.record_id !== recordId) throw new Error("REVIEW_RECORD_INVALID");
    return withLock(mutationLock, async () => {
      const target = recordPath(recordDir, recordId);
      const existing = await readRequiredEnvelope(target, options.session);
      const row = { ...existing.row, ...changes, record_id: recordId, is_admin_edited: "true" };
      row.participantKey = await participantKeyFor({
        participantName: row.participant_name,
        phoneFull: row.phone_full,
        birthdate: row.birthdate,
      });
      assertReviewRow(row);
      await writeEnvelope(target, { ...existing, row });
      return { ...row };
    });
  }

  async function hide(recordId: string): Promise<void> {
    assertReviewRecordId(recordId);
    await withLock(mutationLock, async () => {
      const target = recordPath(recordDir, recordId);
      const existing = await readRequiredEnvelope(target, options.session);
      await writeEnvelope(target, { ...existing, hidden: true });
    });
  }

  async function reset(): Promise<void> {
    await withLock(mutationLock, async () => {
      for (const envelope of await readEnvelopes(recordDir, options.session)) {
        if (!envelope.hidden) await writeEnvelope(recordPath(recordDir, envelope.row.record_id), { ...envelope, hidden: true });
      }
    });
  }

  return { save, list, best, edit, hide, reset, participantKeyFor };
}

async function withLock<T>(lockTarget: string, task: () => Promise<T>): Promise<T> {
  try {
    await fs.mkdir(path.dirname(lockTarget), { recursive: true });
    const handle = await fs.open(lockTarget, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(lockTarget, { retries: { retries: 20, minTimeout: 10, maxTimeout: 100, factor: 1.2 } });
    try {
      return await task();
    } finally {
      await release().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("REVIEW_")) throw error;
    throw new Error("REVIEW_LOCK_FAILED");
  }
}

async function readOrCreateSalt(saltPath: string, saltLock: string): Promise<string> {
  return withLock(saltLock, async () => {
    try {
      const salt = (await fs.readFile(saltPath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/.test(salt)) return salt;
      throw new Error("REVIEW_STATE_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error && error.message.startsWith("REVIEW_")) throw error;
        throw new Error("REVIEW_STATE_INVALID");
      }
    }
    const salt = crypto.randomBytes(32).toString("hex");
    try {
      await atomicWriteFile(saltPath, Buffer.from(`${salt}\n`, "utf8"));
      return salt;
    } catch {
      throw new Error("REVIEW_STATE_WRITE_FAILED");
    }
  });
}

async function readEnvelopes(recordDir: string, session: ReviewSession): Promise<ReviewRecordEnvelope[]> {
  let names: string[];
  try {
    names = await fs.readdir(recordDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("REVIEW_RECORD_CORRUPT");
  }
  const envelopes: ReviewRecordEnvelope[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    envelopes.push(await readRequiredEnvelope(path.join(recordDir, name), session));
  }
  return envelopes;
}

async function readEnvelopeIfPresent(filePath: string, session: ReviewSession): Promise<ReviewRecordEnvelope | null> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return readRequiredEnvelope(filePath, session);
}

async function readRequiredEnvelope(filePath: string, session: ReviewSession): Promise<ReviewRecordEnvelope> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error("REVIEW_RECORD_CORRUPT");
  }
  if (!isEnvelope(value, session)) throw new Error("REVIEW_RECORD_CORRUPT");
  return value;
}

async function writeEnvelope(filePath: string, envelope: ReviewRecordEnvelope): Promise<void> {
  if (!isEnvelope(envelope, envelope.session)) throw new Error("REVIEW_RECORD_INVALID");
  try {
    await atomicWriteFile(filePath, Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"));
  } catch {
    throw new Error("REVIEW_STORAGE_WRITE_FAILED");
  }
}

function recordPath(recordDir: string, recordId: string): string {
  assertReviewRecordId(recordId);
  return path.join(recordDir, `${recordId}.json`);
}

function isEnvelope(value: unknown, session: ReviewSession): value is ReviewRecordEnvelope {
  if (!isPlainObject(value) || !hasExactKeys(value, ["schemaVersion", "reviewMarker", "session", "hidden", "row"])) return false;
  return value.schemaVersion === 1 && value.reviewMarker === REVIEW_MARKER && sameSession(value.session, session) && typeof value.hidden === "boolean" && isReviewRow(value.row);
}

function isReviewRow(value: unknown): value is RecordRow {
  return isPlainObject(value)
    && isReviewRecordId(value.record_id)
    && typeof value.participant_name === "string" && value.participant_name.trim().length > 0
    && typeof value.phone_full === "string" && value.phone_full.trim().length > 0
    && typeof value.birthdate === "string" && value.birthdate.trim().length > 0
    && typeof value.total_time_ms === "string" && Number.isFinite(Number(value.total_time_ms)) && Number(value.total_time_ms) >= 0
    && (value.game_mode === "normal" || value.game_mode === "ai_challenge")
    && (value.participantKey == null || (typeof value.participantKey === "string" && /^[a-f0-9]{64}$/.test(value.participantKey)));
}

function assertReviewRow(row: RecordRow): void {
  if (!isReviewRow(row)) throw new Error("REVIEW_RECORD_INVALID");
}

function isReviewRecordId(value: unknown): value is string {
  return typeof value === "string" && REVIEW_RECORD_ID.test(value);
}

function assertReviewRecordId(value: unknown): asserts value is string {
  if (!isReviewRecordId(value)) throw new Error("REVIEW_RECORD_INVALID");
}

function assertOptions(options: ReviewLocalRuntimeOptions): void {
  if (!options.rootDir || (options.role !== "player" && options.role !== "leaderboard") || !isSession(options.session)) {
    throw new Error("REVIEW_RUNTIME_OPTIONS_INVALID");
  }
}

function isSession(value: ReviewSession): boolean {
  if (!/^[a-z0-9-]{1,100}$/.test(value.sessionId)) return false;
  return value.kind === "practice" || (value.kind === "official" && Number.isInteger(value.dayNo) && value.dayNo > 0 && Number.isInteger(value.roundNo) && value.roundNo > 0);
}

function sameSession(value: unknown, expected: ReviewSession): boolean {
  if (!isPlainObject(value) || !isSession(value as ReviewSession)) return false;
  return value.kind === expected.kind && value.sessionId === expected.sessionId
    && (value.kind === "practice" || (value.dayNo === (expected as Extract<ReviewSession, { kind: "official" }>).dayNo && value.roundNo === (expected as Extract<ReviewSession, { kind: "official" }>).roundNo));
}

function isIdentity(value: unknown): value is { participantName: string; phoneFull: string; birthdate: string } {
  return isPlainObject(value) && [value.participantName, value.phoneFull, value.birthdate].every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}
