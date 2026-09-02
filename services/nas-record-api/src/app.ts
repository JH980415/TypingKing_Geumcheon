import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import type { SessionKind } from "../../../shared/events/types.js";
import type { NasAdminActionV1, NasSessionV1 } from "../../../shared/nas/protocol.js";
import { AuthenticationError, AuxiliaryIpLimiter, TokenBucketLimiter, authenticateRequest, type TokenManifestV1 } from "./auth.js";
import type { RecordValidationConfigV1 } from "./recordSchema.js";
import {
  RecordContradictionError,
  validateAndNormalizeRecord,
} from "./recordSchema.js";
import { RecordStore } from "./recordStore.js";

type AppConfig = RecordValidationConfigV1 & { tokenManifest: TokenManifestV1 };

class RecordQuarantinedResponseError extends Error {
  constructor() {
    super("RECORD_QUARANTINED");
    this.name = "RecordQuarantinedResponseError";
  }
}

export type BuildNasAppDependencies = {
  config: AppConfig;
  now?: () => string | number | Date;
  recordStore?: RecordStore;
  readiness?: () => Promise<boolean>;
  tokenLimiter?: TokenBucketLimiter;
  ipLimiter?: AuxiliaryIpLimiter;
};

export function buildNasApp(dependencies: BuildNasAppDependencies): FastifyInstance {
  const app = Fastify({ bodyLimit: 32 * 1024, logger: false, ajv: { customOptions: { removeAdditional: false } } });
  const store = dependencies.recordStore ?? new RecordStore({ dataRoot: dependencies.config.dataRoot });
  const now = dependencies.now ?? (() => Date.now());
  const tokenLimiter = dependencies.tokenLimiter ?? new TokenBucketLimiter({ capacity: 120, refillPerSecond: 1 });
  const ipLimiter = dependencies.ipLimiter ?? new AuxiliaryIpLimiter({ capacity: 2400, refillPerSecond: 40 });

  app.post("/api/v1/records", {
    schema: {
      body: {
        type: "object",
          required: ["schema_version", "event_id", "session", "row"],
        additionalProperties: false,
        properties: {
          schema_version: { type: "integer" },
          event_id: { type: "string" },
          session: { type: "object" },
            row: { type: "object" },
        },
      },
    },
  }, async (request, reply) => {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:;|$)/i.test(contentType)) throw new Error("CONTENT_TYPE_REQUIRED");
    const principal = authenticateRequest({ ...request.headers, requiredRole: "writer" }, dependencies.config.tokenManifest, now());
    const tokenRate = tokenLimiter.consume(principal.tokenId, Date.now());
    const ipRate = ipLimiter.consume(request.ip || "unknown", Date.now());
    const limited = !tokenRate.allowed ? tokenRate : !ipRate.allowed ? ipRate : undefined;
    if (limited != null) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
      throw new Error("RATE_LIMITED");
    }
    let record;
    try {
      record = validateAndNormalizeRecord(
        request.body,
        principal,
        dependencies.config,
        new Date(now()).toISOString(),
      );
    } catch (error) {
      if (!(error instanceof RecordContradictionError)) throw error;
      assertIdempotencyKey(request.headers["idempotency-key"], error.record.row.record_id);
      const [reasonCode] = error.reasonCodes;
      if (reasonCode == null) throw new Error("CANONICAL_ATTEMPT_INVALID");
      await store.putContradiction(error.record, reasonCode);
      throw new RecordQuarantinedResponseError();
    }
    assertIdempotencyKey(request.headers["idempotency-key"], record.row.record_id);
    const result = await store.put(record);
    return reply.code(result.disposition === "stored" ? 201 : 200).send({
      schema_version: 1,
      disposition: result.disposition,
      record_id: result.recordId,
      payload_sha256: result.payloadSha256,
      stored_sha256: result.storedSha256,
      received_at: result.receivedAt,
    });
  });

  app.get("/api/v1/records", async (request, reply) => {
    const principal = authenticateRequest(
      { ...request.headers, requiredRole: "leaderboard" },
      dependencies.config.tokenManifest,
      now(),
    );
    applyRateLimit(
      tokenLimiter,
      ipLimiter,
      principal.tokenId,
      request.ip || "unknown",
      reply,
    );
    const session = sessionFromQuery(
      request.query,
      dependencies.config,
      principal.allowedSessions,
    );
    const rows = await store.listEffective(session);
    return reply.send({
      schema_version: 1,
      event_id: dependencies.config.eventId,
      session,
      generated_at: new Date(now()).toISOString(),
      rows,
    });
  });

  app.post("/api/v1/admin/actions", async (request, reply) => {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:;|$)/i.test(contentType)) {
      throw new Error("CONTENT_TYPE_REQUIRED");
    }
    const principal = authenticateRequest(
      { ...request.headers, requiredRole: "operator" },
      dependencies.config.tokenManifest,
      now(),
    );
    applyRateLimit(
      tokenLimiter,
      ipLimiter,
      principal.tokenId,
      request.ip || "unknown",
      reply,
    );

    const action = request.body as NasAdminActionV1;
    assertConfiguredSession(
      action?.session,
      dependencies.config,
      principal.allowedSessions,
    );
    const result = await store.putAdminAction(action);
    return reply.code(result.disposition === "stored" ? 201 : 200).send({
      schema_version: 1,
      disposition: result.disposition,
      action_id: result.actionId,
      received_at: result.receivedAt,
    });
  });


  app.get("/api/v1/ready", async (request, reply) => {
    const principal = authenticateRequest(
      request.headers,
      dependencies.config.tokenManifest,
      now(),
    );
    applyRateLimit(
      tokenLimiter,
      ipLimiter,
      principal.tokenId,
      request.ip || "unknown",
      reply,
    );
    const session = sessionFromQuery(
      request.query,
      dependencies.config,
      principal.allowedSessions,
    );
    const configured = dependencies.config.participantHmacKey.byteLength >= 32
      && dependencies.config.stageTextCatalog.length > 0
      && Array.isArray(dependencies.config.tokenManifest.tokens);
    const ready = configured && await (dependencies.readiness ?? (() => store.ready()))();
    if (!ready) throw new Error("STORAGE_UNAVAILABLE");
    return reply.send({
      schema_version: 1,
      status: "ready",
      event_id: principal.eventId,
      device_id: principal.deviceId,
      role: principal.role,
      session,
    });
  });

  app.get("/health", async (_request, reply) => {
    const configured = dependencies.config.participantHmacKey.byteLength >= 32
      && dependencies.config.stageTextCatalog.length > 0
      && Array.isArray(dependencies.config.tokenManifest.tokens);
    const ready = configured && await (dependencies.readiness ?? (() => store.ready()))();
    return reply.code(ready ? 200 : 503).send(ready ? { status: "ok" } : { status: "unavailable" });
  });

  app.setErrorHandler((error, _request, reply) => {
    const handled = error as Error & { code?: string; validation?: unknown; statusCode?: number };
    const code = errorCode(handled);
    const message = handled instanceof RecordQuarantinedResponseError
      ? "기록 정합성을 확인할 수 없습니다."
      : code;
    reply.code(statusFor(handled, code)).send({ schema_version: 1, code, message });
  });
  return app;
}

function assertIdempotencyKey(value: string | string[] | undefined, recordId: string): void {
  if (typeof value !== "string") throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  if (value !== recordId) throw new Error("IDEMPOTENCY_KEY_MISMATCH");
}

function applyRateLimit(
  tokenLimiter: TokenBucketLimiter,
  ipLimiter: AuxiliaryIpLimiter,
  tokenId: string,
  ip: string,
  reply: FastifyReply,
): void {
  const tokenRate = tokenLimiter.consume(tokenId, Date.now());
  const ipRate = ipLimiter.consume(ip, Date.now());
  const limited = !tokenRate.allowed ? tokenRate : !ipRate.allowed ? ipRate : undefined;
  if (limited == null) return;
  reply.header("Retry-After", String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
  throw new Error("RATE_LIMITED");
}

function sessionFromQuery(
  value: unknown,
  config: AppConfig,
  allowedSessions: SessionKind[],
): NasSessionV1 {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SESSION_INVALID");
  }
  const query = value as Record<string, unknown>;
  const kind = query.session_kind;
  let session: NasSessionV1;
  if (kind === "practice") {
    if (
      typeof query.session_id !== "string"
      || !exactQueryKeys(query, ["session_kind", "session_id"])
    ) {
      throw new Error("SESSION_INVALID");
    }
    session = { kind, session_id: query.session_id };
  } else if (kind === "official") {
    const dayNo = Number(query.day_no);
    const roundNo = Number(query.round_no);
    if (
      typeof query.session_id !== "string"
      || !Number.isInteger(dayNo)
      || !Number.isInteger(roundNo)
      || !exactQueryKeys(query, ["session_kind", "session_id", "day_no", "round_no"])
    ) {
      throw new Error("SESSION_INVALID");
    }
    session = {
      kind,
      session_id: query.session_id,
      day_no: dayNo,
      round_no: roundNo,
    };
  } else {
    throw new Error("SESSION_INVALID");
  }
  assertConfiguredSession(session, config, allowedSessions);
  return session;
}

function assertConfiguredSession(
  value: unknown,
  config: AppConfig,
  allowedSessions: SessionKind[],
): asserts value is NasSessionV1 {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SESSION_INVALID");
  }
  const session = value as Record<string, unknown>;
  if (session.kind !== "official" && session.kind !== "practice") {
    throw new Error("SESSION_INVALID");
  }
  if (!allowedSessions.includes(session.kind)) throw new Error("SESSION_SCOPE");
  if (session.kind === "practice") {
    if (session.session_id !== config.allowedSessions.practice.sessionId) {
      throw new Error("SESSION_INVALID");
    }
    return;
  }
  const matches = config.allowedSessions.official.some((configured) =>
    configured.sessionId === session.session_id
    && configured.dayNo === session.day_no
    && configured.roundNo === session.round_no);
  if (!matches) throw new Error("SESSION_INVALID");
}

function exactQueryKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function errorCode(error: Error & { code?: string; validation?: unknown; statusCode?: number }): string {
  if (error instanceof AuthenticationError) return error.code;
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return "BODY_TOO_LARGE";
  if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return "CONTENT_TYPE_REQUIRED";
  if (error.validation != null) return "BODY_INVALID";
  return /^[A-Z_]+$/.test(error.message) ? error.message : "REQUEST_INVALID";
}

function statusFor(error: Error & { code?: string; statusCode?: number }, code: string): number {
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return 413;
  if (code === "AUTH_MISSING" || code === "AUTH_INVALID" || code === "AUTH_EXPIRED" || code === "AUTH_REVOKED") return 401;
  if (code === "DEVICE_SCOPE" || code === "ROLE_SCOPE" || code === "SESSION_SCOPE") return 403;
  if (code === "IDEMPOTENCY_CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code.startsWith("STORAGE_")) return 503;
  if (error.statusCode === 413) return 413;
  return 422;
}
