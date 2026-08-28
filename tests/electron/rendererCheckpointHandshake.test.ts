import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL,
  ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL,
  RendererCheckpointFence,
  requestRendererActiveAttemptCheckpoint
} from "../../electron/rendererCheckpointHandshake";

test("waits for matching renderer checkpoint acknowledgement", async () => {
  const ipc = new EventEmitter();
  let sentChannel = "";
  let sentRequestId = "";
  const target = {
    send(channel: string, requestId: string) {
      sentChannel = channel;
      sentRequestId = requestId;
    }
  };
  let settled = false;
  const resultPromise = requestRendererActiveAttemptCheckpoint({
    ipc,
    target,
    requestId: "checkpoint-request-1",
    timeoutMs: 1000
  }).then((result) => {
    settled = true;
    return result;
  });

  assert.equal(sentChannel, ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL);
  assert.equal(sentRequestId, "checkpoint-request-1");
  ipc.emit(
    ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL,
    { sender: {} },
    sentRequestId,
    true
  );
  await Promise.resolve();
  assert.equal(settled, false);

  ipc.emit(
    ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL,
    { sender: target },
    sentRequestId,
    true
  );
  assert.equal(await resultPromise, "completed");
  assert.equal(ipc.listenerCount(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL), 0);
});

test("times out and removes acknowledgement listener", async () => {
  const ipc = new EventEmitter();
  let timeoutCallback = () => {};
  let clearedTimer: unknown;
  const resultPromise = requestRendererActiveAttemptCheckpoint({
    ipc,
    target: { send() {} },
    timeoutMs: 25,
    requestId: "checkpoint-request-2",
    setTimeoutFn: ((callback: () => void) => {
      timeoutCallback = callback;
      return 17;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((timer: unknown) => {
      clearedTimer = timer;
    }) as typeof clearTimeout
  });

  timeoutCallback();
  assert.equal(await resultPromise, "timed_out");
  assert.equal(clearedTimer, 17);
  assert.equal(ipc.listenerCount(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL), 0);
});

test("allows only the active close request and rejects periodic or late writes while closing", async () => {
  const fence = new RendererCheckpointFence();
  let releaseWrite = () => {};
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writes = 0;
  await fence.run(7, undefined, async () => {
    writes += 1;
  });
  fence.begin(7, "close-request-1");
  await assert.rejects(
    fence.run(7, undefined, async () => {
      writes += 1;
    }),
    /RENDERER_CHECKPOINT_REQUEST_MISMATCH/
  );
  await assert.rejects(
    fence.run(7, "wrong-request", async () => {
      writes += 1;
    }),
    /RENDERER_CHECKPOINT_REQUEST_MISMATCH/
  );
  const queued = fence.run(7, "close-request-1", async () => {
    writes += 1;
    await blockedWrite;
  });

  fence.seal(7, "close-request-1");
  releaseWrite();
  await queued;
  await assert.rejects(
    fence.run(7, "close-request-1", async () => {
      writes += 1;
    }),
    /RENDERER_CHECKPOINT_CLOSED/
  );
  await fence.run(8, undefined, async () => {
    writes += 1;
  });
  assert.equal(writes, 3);
});
