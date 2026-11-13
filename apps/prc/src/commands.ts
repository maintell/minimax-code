import { randomUUID } from 'node:crypto';
import type { Frame } from './frames.ts';
import type { Logger, ProducerSocket } from './producer.ts';

export type CommandResult =
  | { kind: 'ack'; payload: Record<string, unknown> }
  | { kind: 'err'; code: string; message: string; retryable: boolean };

interface Pending {
  bindingId: number;
  resolve(result: CommandResult): void;
  timer: NodeJS.Timeout;
}

interface RouterDeps {
  getProducer(bindingId: number): ProducerSocket | undefined;
  logger: Logger;
  nowMs?: () => number;
}

export class CommandRouter {
  private readonly pending = new Map<string, Pending>();
  private readonly lastByBinding = new Map<number, string>();
  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  pendingCommandId(bindingId: number): string | undefined {
    return this.lastByBinding.get(bindingId);
  }

  request(
    bindingId: number,
    type: string,
    payload: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const producer = this.deps.getProducer(bindingId);
    if (!producer || !producer.isAuthed()) {
      return Promise.resolve({ kind: 'err', code: 'PRODUCER_OFFLINE', message: 'producer is not connected', retryable: true });
    }
    const cmdId = `cmd-${randomUUID()}`;
    this.lastByBinding.set(bindingId, cmdId);
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        this.deps.logger.warn(`command timed out type=${type} id=${cmdId}`);
        resolve({ kind: 'err', code: 'COMMAND_TIMEOUT', message: `${type} timed out`, retryable: true });
      }, opts.timeoutMs ?? 30_000);
      this.pending.set(cmdId, { bindingId, resolve, timer });
      try {
        producer.send(type, payload, { id: cmdId });
        this.deps.logger.info(`command sent type=${type} id=${cmdId}`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(cmdId);
        resolve({ kind: 'err', code: 'PRODUCER_UNAVAILABLE', message: String(error), retryable: true });
      }
    });
  }

  settle(frame: Frame): boolean {
    // A command is answered only by an ack or an err. Any other type that
    // happens to echo a command id — an event, a control frame — must fall
    // through to the fanout with the command still pending, or the real reply
    // would be lost to a fabricated error.
    const isReply = frame.type.startsWith('ack.') || frame.type.startsWith('err.');
    if (!isReply) return false;
    const replyTo = frame.in_reply_to;
    if (!replyTo) return false;
    const pending = this.pending.get(replyTo);
    if (!pending) return false;
    this.pending.delete(replyTo);
    clearTimeout(pending.timer);
    if (frame.type.startsWith('ack.')) {
      pending.resolve({ kind: 'ack', payload: frame.payload });
      return true;
    }
    const code = typeof frame.payload.code === 'string' ? frame.payload.code : 'UNKNOWN';
    const message = typeof frame.payload.message === 'string' ? frame.payload.message : code;
    pending.resolve({ kind: 'err', code, message, retryable: frame.payload.retryable === true });
    return true;
  }

  cancelAll(bindingId: number, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.bindingId !== bindingId) continue;
      clearTimeout(pending.timer);
      pending.resolve({ kind: 'err', code: 'PRODUCER_DISCONNECTED', message: reason, retryable: true });
      this.pending.delete(id);
    }
  }
}
