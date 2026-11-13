import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_MESSAGE_BYTES, decodeFrame, makeFrame, type Frame } from './frames.ts';
import type { Store } from './store.ts';

export interface WsLike {
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ProducerOptions {
  socket: WsLike;
  bindingId: number;
  store: Store;
  logger: Logger;
  onFrame(frame: Frame): void;
  onClose(): void;
}

export class ProducerSocket {
  readonly bindingId: number;
  private authed = false;
  private closed = false;
  private readonly connectionId = randomUUID();
  private readonly opts: ProducerOptions;
  private maxBytes = DEFAULT_MAX_MESSAGE_BYTES;

  constructor(opts: ProducerOptions) {
    this.opts = opts;
    this.bindingId = opts.bindingId;
  }

  start(): void {
    this.sendFrame(makeFrame('ctrl.hello', {
      connection_id: this.connectionId,
      server_time_ms: Date.now(),
      max_message_bytes: this.maxBytes,
    }));
    this.opts.socket.on('message', (data) => this.handle(data));
    this.opts.socket.on('close', () => {
      this.closed = true;
      this.opts.onClose();
    });
  }

  isAuthed(): boolean {
    return this.authed;
  }

  send(type: string, payload: Record<string, unknown>, opts: { inReplyTo?: string; id?: string } = {}): Frame {
    const eventId = this.opts.store.nextEventId(this.bindingId);
    const frame = makeFrame(type, payload, { eventId, ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}) });
    if (opts.id) frame.id = opts.id;
    this.opts.store.appendEvent(this.bindingId, eventId, frame);
    this.sendFrame(frame);
    return frame;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.sendFrame(makeFrame('ctrl.disconnect_reason', { code: reason }));
    this.closed = true;
    this.opts.socket.close(1000, reason);
  }

  private sendFrame(frame: Frame): void {
    try {
      this.opts.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.opts.logger.warn(`producer send failed: ${String(error)}`);
    }
  }

  private handle(data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const decoded = decodeFrame(text, this.maxBytes);
    if (!decoded.ok) {
      this.opts.logger.warn(`drop inbound frame: ${decoded.error.code} ${decoded.error.message}`);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === 'ctrl.auth.complete') {
      this.authed = true;
      this.opts.logger.info(`producer authed binding=${this.bindingId} connection=${this.connectionId}`);
      this.replayMissed(frame);
    }
    if (frame.type === 'ctrl.ping') {
      this.sendFrame(makeFrame('ctrl.pong', {}, { traceId: frame.trace_id }));
      return;
    }
    if (frame.type === 'ctrl.disconnect_reason') {
      this.opts.logger.info(`producer disconnect_reason ${String(frame.payload.code ?? 'unknown')}`);
    }
    this.opts.onFrame(frame);
  }

  // The producer keeps the newest `event_id` it received and offers it back on
  // reconnect. Only frames this gateway emitted are in the log, so a replay can
  // never echo producer traffic; the stored frames go out with their original
  // ids, before any new frame reaches the socket, and are not appended a second
  // time. A cursor that predates the retained window — or any positive cursor
  // while nothing is retained — cannot be served, so the producer is told to
  // refetch state instead of trusting a partial history.
  private replayMissed(frame: Frame): void {
    const lastEventId = Number(frame.payload.last_event_id ?? 0);
    const retainedFrom = this.opts.store.oldestEventId(this.bindingId);
    if (lastEventId > 0 && (retainedFrom === 0 || lastEventId < retainedFrom - 1)) {
      this.opts.logger.info(`replay overflow binding=${this.bindingId} from=${lastEventId}`);
      this.sendFrame(makeFrame('ctrl.replay.overflow', {}));
      return;
    }
    const missed = this.opts.store.replayAfter(this.bindingId, lastEventId) as Frame[];
    if (missed.length > 0) {
      this.opts.logger.info(`replay binding=${this.bindingId} from=${lastEventId} frames=${missed.length}`);
    }
    // Replayed frames bypass `onFrame`: they were settled and fanned out when
    // they were first emitted, and re-running either would duplicate the effect.
    for (const replayed of missed) this.sendFrame(replayed);
  }
}
