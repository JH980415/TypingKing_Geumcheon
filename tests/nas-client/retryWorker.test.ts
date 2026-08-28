import assert from "node:assert/strict";
import test from "node:test";
import { NasApiError } from "../../electron/nas/apiClient";
import { NasRetryWorker, type RetryOutbox, type RetryTransport } from "../../electron/nas/retryWorker";
import type { NasRecordEnvelopeV1 } from "../../shared/nas/protocol";

const envelope = { row: { record_id: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000" } } as NasRecordEnvelopeV1;

function outbox(): RetryOutbox & { removed: string[]; blocked: Array<[string, string]> } {
  const value: RetryOutbox & { removed: string[]; blocked: Array<[string, string]> } = {
    removed: [], blocked: [],
    list: async () => [{ kind: "official", recordId: envelope.row.record_id, envelope }],
    remove: async (_kind, id) => { value.removed.push(id); },
    block: async (_kind, id, reason) => { value.blocked.push([id, reason]); },
  };
  return value;
}

test("retries 429 and 5xx with bounded exponential delays, then removes on ACK", async () => {
  const queue = outbox();
  const delays: number[] = [];
  const failures = [new NasApiError(429, "RATE_LIMITED", 7_000), new NasApiError(503, "UNAVAILABLE")];
  const transport: RetryTransport = { postRecord: async () => { const failure = failures.shift(); if (failure) throw failure; return undefined; } };
  const worker = new NasRetryWorker({ outbox: queue, transport, initialDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 4, sleep: async (ms) => { delays.push(ms); } });

  const result = await worker.flush("official");

  assert.deepEqual(delays, [4_000, 2_000]);
  assert.deepEqual(queue.removed, [envelope.row.record_id]);
  assert.equal(result.sent, 1);
});

for (const status of [409, 413, 422]) {
  test(`blocks HTTP ${status} permanently without retrying or losing evidence`, async () => {
    const queue = outbox();
    let attempts = 0;
    const worker = new NasRetryWorker({
      outbox: queue,
      transport: { postRecord: async () => { attempts += 1; throw new NasApiError(status, "REJECTED"); } },
      initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 4, sleep: async () => undefined,
    });

    const result = await worker.flush("official");

    assert.equal(attempts, 1);
    assert.deepEqual(queue.blocked, [[envelope.row.record_id, `HTTP_${status}`]]);
    assert.equal(result.blocked, 1);
  });
}

for (const status of [401, 403]) {
  test(`stops the queue on HTTP ${status} and retains pending records`, async () => {
    const queue = outbox();
    const worker = new NasRetryWorker({
      outbox: queue,
      transport: { postRecord: async () => { throw new NasApiError(status, "AUTH"); } },
      initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 4, sleep: async () => undefined,
    });

    const result = await worker.flush("official");

    assert.equal(result.authRequired, true);
    assert.deepEqual(queue.removed, []);
    assert.deepEqual(queue.blocked, []);
  });
}

test("retains a record after bounded transient retries are exhausted", async () => {
  const queue = outbox();
  let attempts = 0;
  const worker = new NasRetryWorker({
    outbox: queue,
    transport: { postRecord: async () => { attempts += 1; throw new NasApiError(500, "SERVER"); } },
    initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 3, sleep: async () => undefined,
  });

  const result = await worker.flush("official");

  assert.equal(attempts, 3);
  assert.equal(result.deferred, 1);
  assert.deepEqual(queue.removed, []);
});
