import assert from "node:assert/strict";
import test from "node:test";
import { NasApiClient, NasApiError, type FetchLike } from "../../electron/nas/apiClient";
import { payloadSha256, type NasRecordEnvelopeV1 } from "../../shared/nas/protocol";

const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
const token = "6".repeat(64);
const envelope = {
  schema_version: 1,
  event_id: "geumcheon-science-festival-2026",
  session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
  row: { record_id: recordId, participant_name: "홍길동", phone_full: "01012345678" },
} as NasRecordEnvelopeV1;

test("POSTs canonical JSON over HTTPS with device authentication and verifies ACK hash", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetch: FetchLike = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({
      schema_version: 1,
      disposition: "stored",
      record_id: recordId,
      payload_sha256: payloadSha256(envelope),
      stored_sha256: payloadSha256(envelope),
      received_at: "2026-09-18T01:00:00.000Z",
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "PC01",
    getToken: async () => token,
    fetch,
    requestTimeoutMs: 1_000,
  });

  const ack = await client.postRecord(envelope);

  assert.equal(ack.record_id, recordId);
  assert.equal(request?.input, "https://records.example.test/api/v1/records");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(request?.init?.headers).get("x-device-id"), "PC01");
  assert.equal(new Headers(request?.init?.headers).get("idempotency-key"), recordId);
});

test("rejects a mismatched ACK without exposing participant data", async () => {
  const fetch: FetchLike = async () => new Response(JSON.stringify({
    schema_version: 1,
    disposition: "stored",
    record_id: recordId,
    payload_sha256: "0".repeat(64),
    stored_sha256: "0".repeat(64),
    received_at: "2026-09-18T01:00:00.000Z",
  }), { status: 201, headers: { "content-type": "application/json" } });
  const client = new NasApiClient({ baseUrl: "https://records.example.test", deviceId: "PC01", getToken: async () => token, fetch, requestTimeoutMs: 1_000 });

  await assert.rejects(
    () => client.postRecord(envelope),
    (error: unknown) => error instanceof Error && /ACK/.test(error.message) && !error.message.includes("홍길동") && !error.message.includes("01012345678"),
  );
});

test("returns structured status and Retry-After without echoing a server body", async () => {
  const fetch: FetchLike = async () => new Response(JSON.stringify({ message: "홍길동 01012345678", code: "RATE_LIMITED" }), { status: 429, headers: { "retry-after": "3", "content-type": "application/json" } });
  const client = new NasApiClient({ baseUrl: "https://records.example.test", deviceId: "PC01", getToken: async () => token, fetch, requestTimeoutMs: 1_000 });

  await assert.rejects(
    () => client.postRecord(envelope),
    (error: unknown) => error instanceof NasApiError && error.status === 429 && error.retryAfterMs === 3_000 && error.message === "NAS_HTTP_429",
  );
});

test("refuses non-HTTPS base URLs before making a request", () => {
  assert.throws(() => new NasApiClient({ baseUrl: "http://records.example.test", deviceId: "PC01", getToken: async () => "token-token-token-token", fetch: globalThis.fetch, requestTimeoutMs: 1_000 }), /HTTPS/);
});

test("uses injected timeout timers and aborts a stalled request", async () => {
  let scheduledMs = 0;
  let cleared = false;
  const fetch: FetchLike = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("request included private body")));
  });
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "PC01",
    getToken: async () => token,
    fetch,
    requestTimeoutMs: 750,
    timers: {
      setTimeout: (callback, ms) => { scheduledMs = ms; queueMicrotask(callback); return 17; },
      clearTimeout: (handle) => { assert.equal(handle, 17); cleared = true; },
    },
  });

  await assert.rejects(() => client.postRecord(envelope), (error: unknown) => error instanceof NasApiError && error.message === "NAS_NETWORK_ERROR");
  assert.equal(scheduledMs, 750);
  assert.equal(cleared, true);
});

test("authenticated ready probe verifies event device role and exact session", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetch: FetchLike = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({
      schema_version: 1,
      status: "ready",
      event_id: "geumcheon-science-festival-2026",
      device_id: "PC01",
      role: "writer",
      session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "PC01",
    getToken: async () => "6".repeat(64),
    fetch,
    requestTimeoutMs: 1_000,
  });
  const readyClient = client as NasApiClient & {
    getReady(session: typeof envelope.session, expected: { eventId: string; role: "writer" }): Promise<unknown>;
  };

  assert.equal(typeof readyClient.getReady, "function");
  const identity = await readyClient.getReady(envelope.session, {
    eventId: "geumcheon-science-festival-2026",
    role: "writer",
  });

  assert.equal(request?.input, "https://records.example.test/api/v1/ready?session_kind=official&session_id=official-1&day_no=1&round_no=1");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${"6".repeat(64)}`);
  assert.deepEqual(identity, {
    schema_version: 1,
    status: "ready",
    event_id: "geumcheon-science-festival-2026",
    device_id: "PC01",
    role: "writer",
    session: envelope.session,
  });
});
