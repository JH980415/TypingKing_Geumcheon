import {
  assertNasRecordAck,
  canonicalStringify,
  payloadSha256,
  type NasAdminActionV1,
  type NasRecordAckV1,
  type NasRecordEnvelopeV1,
  type NasRecordsSnapshotV1,
  type NasSessionV1,
} from "../../shared/nas/protocol";
import { isEncoded256BitToken, normalizeNasApiBaseUrl } from "./credentialStore";

export type NasReadyIdentityV1 = {
  schema_version: 1;
  status: "ready";
  event_id: string;
  device_id: string;
  role: "writer" | "leaderboard" | "operator";
  session: NasSessionV1;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type TimerAdapter = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export class NasApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfterMs?: number) {
    super(status > 0 ? `NAS_HTTP_${status}` : code);
    this.name = "NasApiError";
  }
}

export class NasApiClient {
  private readonly baseUrl: string;

  constructor(private readonly options: {
    baseUrl: string;
    deviceId: string;
    getToken(): Promise<string>;
    fetch: FetchLike;
    requestTimeoutMs: number;
    timers?: TimerAdapter;
  }) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    if (!/^(?:PC(?:0[1-9]|10)|LEADERBOARD01)$/.test(options.deviceId)) throw new Error("NAS_DEVICE_ID_INVALID");
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100 || options.requestTimeoutMs > 120_000) throw new Error("NAS_TIMEOUT_INVALID");
  }

  async postRecord(envelope: NasRecordEnvelopeV1): Promise<NasRecordAckV1> {
    const recordId = recordIdOf(envelope);
    const payloadHash = payloadSha256(envelope);
    const value = await this.request("/api/v1/records", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": recordId },
      body: canonicalStringify(envelope),
    });
    try {
      assertNasRecordAck(value, recordId, payloadHash);
    } catch {
      throw new Error("NAS_RECORD_ACK_INVALID");
    }
    return value;
  }

  async getRecords(session: NasSessionV1): Promise<NasRecordsSnapshotV1> {
    const query = new URLSearchParams({ session_kind: session.kind, session_id: session.session_id });
    if (session.kind === "official") {
      query.set("day_no", String(session.day_no));
      query.set("round_no", String(session.round_no));
    }
    const value = await this.request(`/api/v1/records?${query.toString()}`, { method: "GET" });
    assertRecordsSnapshot(value, session);
    return value as NasRecordsSnapshotV1;
  }

  async getReady(
    session: NasSessionV1,
    expected: { eventId: string; role: "writer" | "leaderboard" | "operator" },
  ): Promise<NasReadyIdentityV1> {
    const query = sessionQuery(session);
    const value = await this.request(`/api/v1/ready?${query.toString()}`, { method: "GET" });
    assertReadyIdentity(value, {
      eventId: expected.eventId,
      deviceId: this.options.deviceId,
      role: expected.role,
      session,
    });
    return value;
  }
  async postAdminAction(action: NasAdminActionV1): Promise<unknown> {
    return this.request("/api/v1/admin/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": actionIdOf(action) },
      body: canonicalStringify(action),
    });
  }

  private async request(route: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.getToken();
    if (!isEncoded256BitToken(token)) throw new Error("NAS_CREDENTIAL_INVALID");
    const controller = new AbortController();
    const timers = this.options.timers ?? systemTimers;
    const timeout = timers.setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.options.fetch(`${this.baseUrl}${route}`, {
        ...init,
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${token}`,
          "x-device-id": this.options.deviceId,
          accept: "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch {
      throw new NasApiError(0, "NAS_NETWORK_ERROR");
    } finally {
      timers.clearTimeout(timeout);
    }
    if (!response.ok) throw new NasApiError(response.status, `HTTP_${response.status}`, parseRetryAfter(response.headers.get("retry-after")));
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:;|$)/i.test(contentType)) throw new Error("NAS_RESPONSE_CONTENT_TYPE_INVALID");
    return readLimitedJson(response);
  }
}

const systemTimers: TimerAdapter = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};


function validateBaseUrl(value: string): string {
  return normalizeNasApiBaseUrl(value);
}


function sessionQuery(session: NasSessionV1): URLSearchParams {
  const query = new URLSearchParams({ session_kind: session.kind, session_id: session.session_id });
  if (session.kind === "official") {
    query.set("day_no", String(session.day_no));
    query.set("round_no", String(session.round_no));
  }
  return query;
}

function assertReadyIdentity(
  value: unknown,
    expected: { eventId: string; deviceId: string; role: "writer" | "leaderboard" | "operator"; session: NasSessionV1 },
): asserts value is NasReadyIdentityV1 {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "device_id,event_id,role,schema_version,session,status"
    || value.schema_version !== 1 || value.status !== "ready" || value.event_id !== expected.eventId
    || value.device_id !== expected.deviceId || value.role !== expected.role || !sessionEquals(value.session, expected.session)) {
    throw new Error("NAS_READY_IDENTITY_INVALID");
  }
}

const MAX_NAS_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readLimitedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength != null && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_NAS_JSON_RESPONSE_BYTES) {
    throw new Error("NAS_RESPONSE_TOO_LARGE");
  }

  if (response.body == null) throw new Error("NAS_RESPONSE_JSON_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_NAS_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("NAS_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "NAS_RESPONSE_TOO_LARGE") throw error;
    throw new Error("NAS_RESPONSE_JSON_INVALID");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("NAS_RESPONSE_JSON_INVALID");
  }
}

function sessionEquals(value: unknown, expected: NasSessionV1): boolean {
  if (!isObject(value) || value.kind !== expected.kind || value.session_id !== expected.session_id) return false;
  if (expected.kind === "practice") return Object.keys(value).sort().join(",") === "kind,session_id";
  return Object.keys(value).sort().join(",") === "day_no,kind,round_no,session_id"
    && value.day_no === expected.day_no && value.round_no === expected.round_no;
}
function recordIdOf(envelope: NasRecordEnvelopeV1): string {
  const recordId = (envelope as unknown as { row?: { record_id?: unknown } }).row?.record_id;
  if (typeof recordId !== "string") throw new Error("NAS_RECORD_ID_INVALID");
  return recordId;
}

function actionIdOf(action: NasAdminActionV1): string {
  const actionId = (action as unknown as { action_id?: unknown }).action_id;
  if (typeof actionId !== "string") throw new Error("NAS_ADMIN_ACTION_ID_INVALID");
  return actionId;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value == null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function assertRecordsSnapshot(value: unknown, expectedSession: NasSessionV1): void {
  if (!isObject(value) || value.schema_version !== 1 || value.event_id !== "geumcheon-science-festival-2026" || !Array.isArray(value.rows)) throw new Error("NAS_RECORDS_SNAPSHOT_INVALID");
  if (!isObject(value.session) || value.session.kind !== expectedSession.kind || value.session.session_id !== expectedSession.session_id) throw new Error("NAS_RECORDS_SNAPSHOT_INVALID");
  if (expectedSession.kind === "official" && (value.session.day_no !== expectedSession.day_no || value.session.round_no !== expectedSession.round_no)) throw new Error("NAS_RECORDS_SNAPSHOT_INVALID");
  if (typeof value.generated_at !== "string" || Number.isNaN(Date.parse(value.generated_at))) throw new Error("NAS_RECORDS_SNAPSHOT_INVALID");
  for (const row of value.rows) if (!isObject(row) || typeof row.record_id !== "string") throw new Error("NAS_RECORDS_SNAPSHOT_INVALID");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
