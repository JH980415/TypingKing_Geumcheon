import Fastify, { type FastifyInstance } from "fastify";

import { AuthenticationError, AuxiliaryIpLimiter, TokenBucketLimiter, authenticateRequest, type TokenManifestV1 } from "./auth.js";
import type { RecordValidationConfigV1 } from "./recordSchema.js";
import { validateAndNormalizeRecord } from "./recordSchema.js";
import { RecordStore } from "./recordStore.js";

type AppConfig = RecordValidationConfigV1 & { tokenManifest: TokenManifestV1 };

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
        required: ["schema_version", "event_id", "session", "record"],
        additionalProperties: false,
        properties: {
          schema_version: { type: "integer" },
          event_id: { type: "string" },
          session: { type: "object" },
          record: { type: "object" },
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
    const record = validateAndNormalizeRecord(request.body, principal, dependencies.config, new Date(now()).toISOString());
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string") throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (idempotencyKey !== record.record.record_id) throw new Error("IDEMPOTENCY_KEY_MISMATCH");
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
    reply.code(statusFor(handled, code)).send({ schema_version: 1, code, message: code });
  });
  return app;
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
