import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { GEUMCHEON_NAS_EVENT_ID } from "../../../shared/nas/protocol.js";
import type { SessionKind } from "../../../shared/events/types.js";
import type { NasTokenRole, TokenManifestV1 } from "./auth.js";

export type { TokenManifestV1 } from "./auth.js";

export type NasServerConfigV1 = {
  schemaVersion: 1;
  eventId: typeof GEUMCHEON_NAS_EVENT_ID;
  dataRoot: string;
  recordBaseFolderName: "기록저장";
  stageTextCatalogPath: string;
  allowedSessions: {
    official: Array<{ sessionId: string; dayNo: number; roundNo: number }>;
    practice: { sessionId: string };
  };
  aiRanges: {
    official: [[150, 200], [200, 250], [250, 300]];
    practice: [[100, 150], [150, 200], [200, 250]];
  };
};

export type LoadedNasConfigV1 = NasServerConfigV1 & {
  tokenManifest: TokenManifestV1;
  participantHmacKey: Buffer;
};

export type NasConfigEnvironment = {
  NAS_EVENT_CONFIG?: string;
  NAS_TOKEN_MANIFEST?: string;
  NAS_DATA_ROOT?: string;
  NAS_PARTICIPANT_HMAC_KEY_FILE?: string;
};

export function loadNasConfig(env: NasConfigEnvironment): LoadedNasConfigV1 {
  const eventConfigPath = requiredPath(env.NAS_EVENT_CONFIG, "NAS_EVENT_CONFIG");
  const tokenManifestPath = requiredPath(env.NAS_TOKEN_MANIFEST, "NAS_TOKEN_MANIFEST");
  const dataRoot = requiredPath(env.NAS_DATA_ROOT, "NAS_DATA_ROOT");
  const participantHmacKeyPath = requiredPath(env.NAS_PARTICIPANT_HMAC_KEY_FILE, "NAS_PARTICIPANT_HMAC_KEY_FILE");

  assertProtectedFile(eventConfigPath);
  assertProtectedFile(tokenManifestPath);
  assertProtectedFile(participantHmacKeyPath);

  const config = parseEventConfig(readJson(eventConfigPath));
  assertProtectedFile(config.stageTextCatalogPath);
  const tokenManifest = parseTokenManifest(readJson(tokenManifestPath));
  const participantHmacKey = readHmacKey(participantHmacKeyPath);
  if (tokenManifest.eventId !== config.eventId) throw new Error("TOKEN_EVENT_INVALID");

  return { ...config, dataRoot, tokenManifest, participantHmacKey };
}

function parseEventConfig(value: unknown): Omit<NasServerConfigV1, "dataRoot"> {
  const config = exactObject(value, [
    "schemaVersion",
    "eventId",
    "recordBaseFolderName",
    "stageTextCatalogPath",
    "allowedSessions",
    "aiRanges",
  ], "CONFIG");
  if (config.schemaVersion !== 1) throw new Error("CONFIG_SCHEMA_INVALID");
  if (config.eventId !== GEUMCHEON_NAS_EVENT_ID) throw new Error("CONFIG_EVENT_INVALID");
  if (config.recordBaseFolderName !== "기록저장") throw new Error("CONFIG_FOLDER_INVALID");
  const stageTextCatalogPath = requiredPath(config.stageTextCatalogPath, "CONFIG_CATALOG");

  const allowed = exactObject(config.allowedSessions, ["official", "practice"], "SESSION_CONFIG");
  if (!Array.isArray(allowed.official) || allowed.official.length === 0) throw new Error("OFFICIAL_SESSION_INVALID");
  const official = allowed.official.map((entry) => {
    const session = exactObject(entry, ["sessionId", "dayNo", "roundNo"], "OFFICIAL_SESSION");
    return {
      sessionId: nonEmptyString(session.sessionId, "OFFICIAL_SESSION_INVALID"),
      dayNo: positiveInteger(session.dayNo, "OFFICIAL_SESSION_INVALID"),
      roundNo: positiveInteger(session.roundNo, "OFFICIAL_SESSION_INVALID"),
    };
  });
  const officialIds = new Set(official.map((session) => session.sessionId));
  const officialRounds = new Set(official.map((session) => `${session.dayNo}:${session.roundNo}`));
  if (officialIds.size !== official.length || officialRounds.size !== official.length) throw new Error("OFFICIAL_SESSION_DUPLICATE");
  const practiceObject = exactObject(allowed.practice, ["sessionId"], "PRACTICE_SESSION");
  const practice = { sessionId: nonEmptyString(practiceObject.sessionId, "PRACTICE_SESSION_INVALID") };
  if (officialIds.has(practice.sessionId)) throw new Error("SESSION_ID_DUPLICATE");

  const aiRangesObject = exactObject(config.aiRanges, ["official", "practice"], "AI_RANGES");
  assertExactRanges(aiRangesObject.official, [[150, 200], [200, 250], [250, 300]], "OFFICIAL_AI_RANGES_INVALID");
  assertExactRanges(aiRangesObject.practice, [[100, 150], [150, 200], [200, 250]], "PRACTICE_AI_RANGES_INVALID");

  return {
    schemaVersion: 1,
    eventId: GEUMCHEON_NAS_EVENT_ID,
    recordBaseFolderName: "기록저장",
    stageTextCatalogPath,
    allowedSessions: { official, practice },
    aiRanges: {
      official: [[150, 200], [200, 250], [250, 300]],
      practice: [[100, 150], [150, 200], [200, 250]],
    },
  };
}

function parseTokenManifest(value: unknown): TokenManifestV1 {
  const manifest = exactObject(value, ["manifestVersion", "eventId", "tokens"], "TOKEN_MANIFEST");
  if (manifest.manifestVersion !== 1) throw new Error("TOKEN_MANIFEST_VERSION_INVALID");
  if (manifest.eventId !== GEUMCHEON_NAS_EVENT_ID) throw new Error("TOKEN_EVENT_INVALID");
  if (!Array.isArray(manifest.tokens) || manifest.tokens.length === 0) throw new Error("TOKEN_LIST_INVALID");

  const tokenIds = new Set<string>();
  const tokenHashes = new Set<string>();
  const tokens = manifest.tokens.map((value) => {
    const token = exactObject(value, [
      "tokenId",
      "tokenHash",
      "deviceId",
      "role",
      "allowedSessions",
      "expiresAt",
      "revokedAt",
    ], "TOKEN");
    const tokenId = nonEmptyString(token.tokenId, "TOKEN_ID_INVALID");
    if (tokenIds.has(tokenId)) throw new Error("TOKEN_ID_DUPLICATE");
    tokenIds.add(tokenId);
    if (typeof token.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(token.tokenHash)) throw new Error("TOKEN_HASH_INVALID");
    if (tokenHashes.has(token.tokenHash)) throw new Error("TOKEN_HASH_DUPLICATE");
    tokenHashes.add(token.tokenHash);
    const deviceId = nonEmptyString(token.deviceId, "TOKEN_DEVICE_INVALID");
    if (token.role !== "writer" && token.role !== "leaderboard" && token.role !== "operator") throw new Error("TOKEN_ROLE_INVALID");
    const role: NasTokenRole = token.role;
    if (!Array.isArray(token.allowedSessions) || token.allowedSessions.length === 0) throw new Error("TOKEN_SESSION_INVALID");
    const allowedSessions: SessionKind[] = token.allowedSessions.map((session) => {
      if (session !== "official" && session !== "practice") throw new Error("TOKEN_SESSION_INVALID");
      return session;
    });
    if (new Set(allowedSessions).size !== allowedSessions.length) throw new Error("TOKEN_SESSION_DUPLICATE");
    const expiresAt = isoTimestamp(token.expiresAt, "TOKEN_EXPIRY_INVALID");
    const revokedAt = token.revokedAt === null ? null : isoTimestamp(token.revokedAt, "TOKEN_REVOCATION_INVALID");
    return { tokenId, tokenHash: token.tokenHash, deviceId, role, allowedSessions, expiresAt, revokedAt };
  });

  return { manifestVersion: 1, eventId: GEUMCHEON_NAS_EVENT_ID, tokens };
}

function readHmacKey(path: string): Buffer {
  let material: Buffer;
  try {
    material = readFileSync(path);
  } catch {
    throw new Error("HMAC_KEY_UNREADABLE");
  }
  const ascii = material.toString("ascii").trim();
  const key = /^[0-9a-fA-F]{64,}$/.test(ascii) && ascii.length % 2 === 0 ? Buffer.from(ascii, "hex") : material;
  if (key.byteLength < 32) throw new Error("HMAC_KEY_INVALID");
  return Buffer.from(key);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("CONFIG_JSON_INVALID");
  }
}

function assertProtectedFile(path: string): void {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error("not file");
    if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) throw new Error("writable");
  } catch {
    throw new Error("CONFIG_FILE_PERMISSION_INVALID");
  }
}

function exactObject(value: unknown, keys: readonly string[], prefix: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${prefix}_OBJECT_INVALID`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`${prefix}_UNKNOWN_KEY`);
  for (const key of keys) if (!(key in object)) throw new Error(`${prefix}_MISSING_KEY`);
  return object;
}

function requiredPath(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) throw new Error(`${code}_INVALID`);
  return value;
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function isoTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(code);
  }
  return value;
}

function assertExactRanges(value: unknown, expected: readonly (readonly [number, number])[], code: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) throw new Error(code);
  for (let index = 0; index < expected.length; index += 1) {
    const range = value[index];
    if (!Array.isArray(range) || range.length !== 2 || range[0] !== expected[index]![0] || range[1] !== expected[index]![1]) {
      throw new Error(code);
    }
  }
}
