import { randomUUID } from "node:crypto";

export const ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL =
  "records:requestActiveAttemptCheckpoint";
export const ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL =
  "records:activeAttemptCheckpointReady";

export type RendererCheckpointResult =
  | "completed"
  | "failed"
  | "timed_out"
  | "unavailable";

type CheckpointAckEvent = {
  sender: unknown;
};

type CheckpointAckListener = (
  event: CheckpointAckEvent,
  requestId: unknown,
  succeeded: unknown
) => void;

export type RendererCheckpointIpc = {
  on(channel: string, listener: CheckpointAckListener): unknown;
  removeListener(channel: string, listener: CheckpointAckListener): unknown;
};

export type RendererCheckpointTarget = {
  send(channel: string, requestId: string): void;
  isDestroyed?(): boolean;
};

export class RendererCheckpointFence {
  private readonly closing = new Map<number, {
    requestId: string;
    sealed: boolean;
  }>();

  begin(senderId: number, requestId: string): void {
    this.closing.set(senderId, { requestId, sealed: false });
  }

  seal(senderId: number, requestId: string): void {
    const state = this.closing.get(senderId);
    if (!state || state.requestId !== requestId) return;
    state.sealed = true;
  }

  async run<T>(
    senderId: number,
    requestId: string | undefined,
    task: () => Promise<T>
  ): Promise<T> {
    const state = this.closing.get(senderId);
    if (!state) {
      if (requestId !== undefined) {
        throw new Error("RENDERER_CHECKPOINT_REQUEST_MISMATCH");
      }
      return task();
    }
    if (state.sealed) {
      throw new Error("RENDERER_CHECKPOINT_CLOSED");
    }
    if (requestId !== state.requestId) {
      throw new Error("RENDERER_CHECKPOINT_REQUEST_MISMATCH");
    }
    return task();
  }
}

export function requestRendererActiveAttemptCheckpoint({
  ipc,
  target,
  timeoutMs = 900,
  requestId = randomUUID(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}: {
  ipc: RendererCheckpointIpc;
  target: RendererCheckpointTarget;
  timeoutMs?: number;
  requestId?: string;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<RendererCheckpointResult> {
  if (target.isDestroyed?.()) return Promise.resolve("unavailable");

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RendererCheckpointResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeoutFn(timer);
      ipc.removeListener(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL, onAck);
      resolve(result);
    };
    const onAck: CheckpointAckListener = (event, receivedRequestId, succeeded) => {
      if (event.sender !== target || receivedRequestId !== requestId) return;
      finish(succeeded === true ? "completed" : "failed");
    };

    ipc.on(ACTIVE_ATTEMPT_CHECKPOINT_ACK_CHANNEL, onAck);
    timer = setTimeoutFn(() => finish("timed_out"), Math.max(1, timeoutMs));
    try {
      target.send(ACTIVE_ATTEMPT_CHECKPOINT_REQUEST_CHANNEL, requestId);
    } catch {
      finish("unavailable");
    }
  });
}
