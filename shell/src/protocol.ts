/**
 * Wire-level types for the bridge JSON-RPC transport.
 *
 * The shell talks to the gdou bridge over a direct WebSocket speaking JSON-RPC
 * 2.0 (see `lib/ipc.ts`). This module keeps the few types that transport needs
 * in one place. The previous contents re-exported a `packages/protocol` module
 * that no longer exists in this repository.
 */

/** 来自桥的事件负载。具体结构由 shell 的时间线归一化层（App.vue）消费。 */
export type RuntimeEvent = Record<string, unknown>;

/** 桥推送的事件信封：{ kind: "event", event }。 */
export interface EventEnvelope {
  kind: "event";
  event: RuntimeEvent;
}

/** JSON-RPC 2.0 响应。 */
export interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string };
}
