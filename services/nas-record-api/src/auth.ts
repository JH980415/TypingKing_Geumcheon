import { createHash, timingSafeEqual } from "node:crypto";

import { GEUMCHEON_NAS_EVENT_ID } from "../../../shared/nas/protocol.js";
import type { SessionKind } from "../../../shared/events/types.js";

export type NasTokenRole = "writer" | "leaderboard" | "operator";

export type TokenManifestV1 = {
  manifestVersion: 1;
  eventId: typeof GEUMCHEON_NAS_EVENT_ID;
  tokens: Array<{
    tokenId: string;
    tokenHash: string;
    deviceId: string;
    role: NasTokenRole;
    allowedSessions: SessionKind[];
    expiresAt: string;
    revokedAt: string | null;
  }>;
};

export type AuthenticationHeaders = Record<string, string | string[] | undefined> & {
  eventId?: string;
  requiredRole?: NasTokenRole;
  requiredRoles?: NasTokenRole[];
  sessionKind?: SessionKind;
};

export type AuthenticatedPrincipal = {
  tokenId: string;
  deviceId: string;
  eventId: typeof GEUMCHEON_NAS_EVENT_ID;
  role: NasTokenRole;
  allowedSessions: SessionKind[];
};

export type RateLimitResult = { allowed: true; retryAfterMs: 0 } | { allowed: false; retryAfterMs: number };

export class AuthenticationError extends Error {
  readonly code: "AUTH_MISSING" | "AUTH_INVALID" | "AUTH_EXPIRED" | "AUTH_REVOKED" | "DEVICE_SCOPE" | "ROLE_SCOPE" | "SESSION_SCOPE";

  constructor(code: AuthenticationError["code"]) {
    super(code);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export function authenticateRequest(
  headers: AuthenticationHeaders,
  manifest: TokenManifestV1,
  now: number | string | Date,
): AuthenticatedPrincipal {
  const authorization = singleHeader(headers, "authorization");
  if (authorization == null) throw new AuthenticationError("AUTH_MISSING");
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match == null || !isEncoded256BitToken(match[1])) throw new AuthenticationError("AUTH_INVALID");

  const suppliedHash = createHash("sha256").update(match[1], "utf8").digest();
  let matchedToken: TokenManifestV1["tokens"][number] | undefined;
  for (const token of manifest.tokens) {
    const candidateHash = /^[0-9a-f]{64}$/.test(token.tokenHash)
      ? Buffer.from(token.tokenHash, "hex")
      : Buffer.alloc(32);
    if (timingSafeEqual(suppliedHash, candidateHash) && /^[0-9a-f]{64}$/.test(token.tokenHash)) {
      matchedToken = token;
    }
  }
  if (matchedToken == null) throw new AuthenticationError("AUTH_INVALID");

  const nowMs = timestampMs(now);
  const expiresAt = Date.parse(matchedToken.expiresAt);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) throw new AuthenticationError("AUTH_EXPIRED");
  if (matchedToken.revokedAt != null) throw new AuthenticationError("AUTH_REVOKED");
  if (manifest.eventId !== GEUMCHEON_NAS_EVENT_ID || (headers.eventId != null && headers.eventId !== manifest.eventId)) {
    throw new AuthenticationError("AUTH_INVALID");
  }

  const deviceId = singleHeader(headers, "x-device-id");
  if (deviceId == null || deviceId !== matchedToken.deviceId) throw new AuthenticationError("DEVICE_SCOPE");
  if (headers.requiredRole != null && headers.requiredRole !== matchedToken.role) {
    throw new AuthenticationError("ROLE_SCOPE");
  }
  if (headers.requiredRoles != null && !headers.requiredRoles.includes(matchedToken.role)) {
    throw new AuthenticationError("ROLE_SCOPE");
  }
  if (headers.sessionKind != null && !matchedToken.allowedSessions.includes(headers.sessionKind)) {
    throw new AuthenticationError("SESSION_SCOPE");
  }

  return {
    tokenId: matchedToken.tokenId,
    deviceId: matchedToken.deviceId,
    eventId: manifest.eventId,
    role: matchedToken.role,
    allowedSessions: [...matchedToken.allowedSessions],
  };
}

type LimiterOptions = { capacity: number; refillPerSecond: number };
type BucketState = { available: number; updatedAt: number };

export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #buckets = new Map<string, BucketState>();

  constructor(options: LimiterOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || !Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new Error("RATE_LIMIT_CONFIG_INVALID");
    }
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerSecond / 1000;
  }

  consume(tokenId: string, now: number): RateLimitResult {
    if (tokenId.trim() === "") throw new Error("RATE_LIMIT_KEY_INVALID");
    if (!Number.isFinite(now)) throw new Error("RATE_LIMIT_TIME_INVALID");

    const previous = this.#buckets.get(tokenId) ?? { available: this.#capacity, updatedAt: now };
    const elapsed = Math.max(0, now - previous.updatedAt);
    const available = Math.min(this.#capacity, previous.available + elapsed * this.#refillPerMs);
    if (available >= 1) {
      this.#buckets.set(tokenId, { available: available - 1, updatedAt: Math.max(now, previous.updatedAt) });
      return { allowed: true, retryAfterMs: 0 };
    }

    this.#buckets.set(tokenId, { available, updatedAt: Math.max(now, previous.updatedAt) });
    return { allowed: false, retryAfterMs: Math.ceil((1 - available) / this.#refillPerMs) };
  }
}

export class AuxiliaryIpLimiter extends TokenBucketLimiter {}

function singleHeader(headers: AuthenticationHeaders, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof entry === "string" ? entry : undefined;
}

function timestampMs(value: number | string | Date): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AuthenticationError("AUTH_INVALID");
  return parsed;
}

function isEncoded256BitToken(value: string): boolean {
  if (/^[0-9a-f]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}
