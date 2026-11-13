import type { CommandRouter } from './commands.ts';
import type { Frame } from './frames.ts';
import type { WsLike } from './producer.ts';

// The producer's decision codes: 1 allows the tool call, 2 denies it.
const PERMISSION_DECISIONS = new Map<string, number>([
  ['allowOnce', 1],
  ['allowAlways', 1],
  ['deny', 2],
]);

// The decision code alone cannot express "always": the producer reads the
// persistence of an allow from `remember` (1 always, 3 once) and treats a
// missing field as a one-off approval. Both allow variants therefore send it.
const PERMISSION_REMEMBER = new Map<string, number>([
  ['allowAlways', 1],
  ['allowOnce', 3],
]);

// Design section 8 is the complete command surface a browser may request. The
// list is explicit so that forwarding a new producer command is a reviewed change
// rather than a passthrough of whatever a tab names.
export const SUPPORTED_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set([
    'cmd.session.list',
    'cmd.session.history',
    'cmd.session.send',
    'cmd.session.new',
    'cmd.session.resume',
    'cmd.session.stop',
    'cmd.session.pin',
    'cmd.session.get',
    'cmd.session.update',
    'cmd.session.delete',
    'cmd.permission.respond',
    'cmd.workspace.list',
    'cmd.projects.list',
    'cmd.pinned.list',
    'cmd.pinned.reorder',
    'cmd.model.list',
    'cmd.skill.list',
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The browser decision is a name the console renders; the producer only
// understands its numeric codes. One lookup keeps the two ends in step, and an
// unknown name yields undefined so it can never default to an allow.
export function permissionResponsePayload(
  decision: string,
  requestIds: string[],
): { request_ids: string[]; decision: number; remember?: number } | undefined {
  const code = PERMISSION_DECISIONS.get(decision);
  if (code === undefined) return undefined;
  const remember = PERMISSION_REMEMBER.get(decision);
  return { request_ids: requestIds, decision: code, ...(remember !== undefined ? { remember } : {}) };
}

// An ask is reshaped once, here, instead of in every tab. `tool_input` is
// carried to the console for display and must never be written to a log.
export function toPermissionCard(payload: Record<string, unknown>) {
  return {
    requestId: String(payload.request_id ?? ''),
    sessionId: String(payload.session_id ?? ''),
    toolName: String(payload.tool_name ?? ''),
    toolInput: typeof payload.tool_input === 'string' ? payload.tool_input : '',
    ruleContents: typeof payload.rule_contents === 'string' ? payload.rule_contents : '',
    reason: typeof payload.reason === 'string' ? payload.reason : '',
  };
}

// The producer reports the turn terminal with the protocol's numeric enum
// (1 ok, 2 error, 3 aborted) while the console contract names the same states.
// An unrecognised value is passed through unchanged rather than inventing a
// terminal the producer never sent.
const TURN_END_STATUS_NAMES = new Map<number, string>([
  [1, 'finished'],
  [2, 'error'],
  [3, 'aborted'],
]);

export function toTurnEndPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const name = typeof payload.status === 'number' ? TURN_END_STATUS_NAMES.get(payload.status) : undefined;
  return name === undefined ? payload : { ...payload, status: name };
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

// Only `evt.` frames are browser events. An `ack.*` or `err.*` frame answers a
// command on the socket that asked, and a `ctrl.*` frame steers the producer
// connection, so broadcasting either would show a tab a frame it cannot place.
export function eventFanout(hub: ConsumerHub, bindingId: number, frame: Frame): void {
  if (!frame.type.startsWith('evt.')) return;
  hub.broadcast(bindingId, {
    kind: 'evt',
    type: frame.type,
    payload: frame.type === 'evt.permission.ask'
      ? toPermissionCard(frame.payload)
      : frame.type === 'evt.session.turn_end'
        ? toTurnEndPayload(frame.payload)
        : frame.payload,
    eventId: frame.event_id,
  });
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
    if (!SUPPORTED_COMMANDS.has(type)) {
      reply(socket, {
        kind: 'err',
        requestId,
        code: 'UNSUPPORTED_COMMAND',
        message: `${type} is not a supported command`,
        retryable: false,
      });
      return;
    }
    const result = await router.request(bindingId, type, payload);
    reply(socket, { ...result, kind: result.kind, requestId });
    return;
  }

  if (message.kind === 'permission') {
    if (typeof message.decision !== 'string') return;
    const requestIds = Array.isArray(message.requestIds) ? message.requestIds.map(String) : [];
    const payload = permissionResponsePayload(message.decision, requestIds);
    // An unrecognised decision must not default to "allow".
    if (!payload) return;
    const result = await router.request(bindingId, 'cmd.permission.respond', payload);
    reply(socket, { ...result, requestId });
    void hub;
  }
}
