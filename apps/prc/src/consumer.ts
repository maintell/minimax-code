import type { CommandRouter } from './commands.ts';
import type { WsLike } from './producer.ts';

// The producer's decision codes: 1 allows the tool call, 2 denies it.
const PERMISSION_DECISIONS = new Map<string, number>([
  ['allowOnce', 1],
  ['allowAlways', 1],
  ['deny', 2],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ConsumerHub {
  private readonly byBinding = new Map<number, Set<WsLike>>();

  addSocket(socket: WsLike, bindingId: number): void {
    const set = this.byBinding.get(bindingId) ?? new Set<WsLike>();
    set.add(socket);
    this.byBinding.set(bindingId, set);
  }

  removeSocket(socket: WsLike, bindingId: number): void {
    const set = this.byBinding.get(bindingId);
    if (!set) return;
    set.delete(socket);
    // Keep the map bounded by live bindings rather than empty sets.
    if (set.size === 0) this.byBinding.delete(bindingId);
  }

  socketCount(bindingId: number): number {
    return this.byBinding.get(bindingId)?.size ?? 0;
  }

  broadcast(bindingId: number, message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.byBinding.get(bindingId) ?? []) {
      try {
        socket.send(text);
      } catch {
        // A closing socket is not an error for the caller.
      }
    }
  }
}

function reply(socket: WsLike, message: unknown): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The tab closed while its command was in flight; the result is lost.
  }
}

export async function handleConsumerFrame(
  hub: ConsumerHub,
  router: CommandRouter,
  socket: WsLike,
  bindingId: number,
  raw: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  // A browser tab is untrusted input: anything that is not a known shape is
  // dropped, never thrown, so one bad frame cannot close the socket.
  if (!isRecord(parsed)) return;
  const message = parsed;
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;

  if (message.kind === 'cmd') {
    if (typeof message.type !== 'string' || !message.type) return;
    const payload = message.payload === undefined ? {} : message.payload;
    if (!isRecord(payload)) return;
    const type = message.type.startsWith('cmd.') ? message.type : `cmd.${message.type}`;
    const result = await router.request(bindingId, type, payload);
    reply(socket, { ...result, kind: result.kind, requestId });
    return;
  }

  if (message.kind === 'permission') {
    if (typeof message.decision !== 'string') return;
    const decision = PERMISSION_DECISIONS.get(message.decision);
    // An unrecognised decision must not default to "allow".
    if (decision === undefined) return;
    const requestIds = Array.isArray(message.requestIds) ? message.requestIds.map(String) : [];
    const result = await router.request(bindingId, 'cmd.permission.respond', {
      request_ids: requestIds,
      decision,
    });
    reply(socket, { ...result, requestId });
    void hub;
  }
}
