import type { SessionKind } from "../../shared/events/types";
import type { NasRecordEnvelopeV1 } from "../../shared/nas/protocol";
import { NasApiError } from "./apiClient";

export type RetryItem = { kind: SessionKind; recordId: string; envelope: NasRecordEnvelopeV1 };
export type RetryOutbox = {
  list(kind: SessionKind): Promise<RetryItem[]>;
  remove(kind: SessionKind, recordId: string): Promise<void>;
  block(kind: SessionKind, recordId: string, reason: string): Promise<void>;
};
export type RetryTransport = { postRecord(envelope: NasRecordEnvelopeV1): Promise<unknown> };
export type RetryFlushResult = { attempted: number; sent: number; blocked: number; deferred: number; authRequired: boolean };

export class NasRetryWorker {
  constructor(private readonly options: {
    outbox: RetryOutbox;
    transport: RetryTransport;
    initialDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
    sleep(ms: number): Promise<void>;
  }) {
    if (!Number.isInteger(options.initialDelayMs) || options.initialDelayMs < 0) throw new Error("NAS_RETRY_CONFIG_INVALID");
    if (!Number.isInteger(options.maxDelayMs) || options.maxDelayMs < options.initialDelayMs) throw new Error("NAS_RETRY_CONFIG_INVALID");
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 20) throw new Error("NAS_RETRY_CONFIG_INVALID");
  }

  async flush(kind: SessionKind): Promise<RetryFlushResult> {
    const result: RetryFlushResult = { attempted: 0, sent: 0, blocked: 0, deferred: 0, authRequired: false };
    for (const item of await this.options.outbox.list(kind)) {
      let finalState: "sent" | "blocked" | "deferred" | "auth" = "deferred";
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        result.attempted += 1;
        try {
          await this.options.transport.postRecord(item.envelope);
          await this.options.outbox.remove(kind, item.recordId);
          finalState = "sent";
          break;
        } catch (error) {
          const status = error instanceof NasApiError ? error.status : 0;
          if (status === 401 || status === 403) { finalState = "auth"; break; }
          if (status === 409 || status === 413 || status === 422) {
            await this.options.outbox.block(kind, item.recordId, `HTTP_${status}`);
            finalState = "blocked";
            break;
          }
          if (!isTransient(status) || attempt === this.options.maxAttempts) break;
          const exponential = this.options.initialDelayMs * (2 ** (attempt - 1));
          const requested = error instanceof NasApiError ? error.retryAfterMs : undefined;
          await this.options.sleep(Math.min(this.options.maxDelayMs, requested ?? exponential));
        }
      }
      if (finalState === "sent") result.sent += 1;
      if (finalState === "blocked") result.blocked += 1;
      if (finalState === "deferred") result.deferred += 1;
      if (finalState === "auth") { result.authRequired = true; break; }
    }
    return result;
  }
}

function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}
