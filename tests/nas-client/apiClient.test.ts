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

test("uses fail-closed redirect and cache policy for every NAS request", async () => {
  let requestInit: RequestInit | undefined;
  const fetch: FetchLike = async (_input, init) => {
    requestInit = init;
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

  await client.postRecord(envelope);

  assert.equal(requestInit?.redirect, "error");
  assert.equal(requestInit?.cache, "no-store");
});

test("rejects streamed JSON above the finite limit despite missing or misleading content-length", async () => {
  for (const declaredLength of [undefined, "1"] as const) {
    const oversized = JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) });
    const headers = new Headers({ "content-type": "application/json" });
    if (declaredLength !== undefined) headers.set("content-length", declaredLength);
    const fetch: FetchLike = async () => new Response(oversized, { status: 200, headers });
    const client = new NasApiClient({
      baseUrl: "https://records.example.test",
      deviceId: "LEADERBOARD01",
      getToken: async () => token,
      fetch,
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(
      () => client.getRecords(envelope.session),
      (error: unknown) => error instanceof Error
        && error.message === "NAS_RESPONSE_TOO_LARGE"
        && !error.message.includes(oversized.slice(0, 32)),
      `declared content-length ${declaredLength ?? "missing"}`,
    );
  }
});

test("accepts authenticated leaderboard ready identity", async () => {
  const fetch: FetchLike = async () => new Response(JSON.stringify({
    schema_version: 1,
    status: "ready",
    event_id: "geumcheon-science-festival-2026",
    device_id: "LEADERBOARD01",
    role: "leaderboard",
    session: envelope.session,
  }), { status: 200, headers: { "content-type": "application/json" } });
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "LEADERBOARD01",
    getToken: async () => token,
    fetch,
    requestTimeoutMs: 1_000,
  });

  const identity = await client.getReady(envelope.session, {
    eventId: "geumcheon-science-festival-2026",
    role: "leaderboard",
  });

  assert.equal(identity.role, "leaderboard");
});

test("keeps the request timeout armed until the JSON body is fully read", async () => {
  const timer: { callback?: () => void; cleared: boolean } = { cleared: false };
  const fetch: FetchLike = async (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "PC01",
    getToken: async () => token,
    fetch,
    requestTimeoutMs: 750,
    timers: {
      setTimeout: (callback) => { timer.callback = callback; return 23; },
      clearTimeout: () => { timer.cleared = true; },
    },
  });
  const outcome = client.getRecords({ kind: "official", session_id: "official-1", day_no: 1, round_no: 1 }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : "rejected");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timer.cleared, false, "timeout must stay armed while the body is still streaming");
  timer.callback?.();
  const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("HUNG"), 500))]);
  assert.notEqual(result, "HUNG", "a stalled body must not hang the caller");
  assert.notEqual(result, "resolved");
  assert.equal(timer.cleared, true);
});

test("exposes the server clock skew measured from the Date header", async () => {
  const client = new NasApiClient({
    baseUrl: "https://records.example.test",
    deviceId: "PC01",
    getToken: async () => token,
    fetch: async () => new Response(JSON.stringify({
      schema_version: 1,
      status: "ready",
      event_id: "geumcheon-science-festival-2026",
      device_id: "PC01",
      role: "writer",
      session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
    }), { status: 200, headers: { "content-type": "application/json", date: new Date(Date.now() - 10_000).toUTCString() } }),
    requestTimeoutMs: 1_000,
  });
  assert.equal(client.serverClockSkewMs(), undefined);
  await client.getReady({ kind: "official", session_id: "official-1", day_no: 1, round_no: 1 }, { eventId: "geumcheon-science-festival-2026", role: "writer" });
  const skew = client.serverClockSkewMs();
  assert.ok(typeof skew === "number" && skew >= 9_000 && skew <= 12_000, `client should measure about +10 s ahead, got ${skew}`);
});
