import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const INBOUND_IDLE_TIMEOUT_MS = 15_000;
export const TICKET_TTL_MS = 60_000;

export interface Frame {
  v: number;
  id: string;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
  source?: string;
  in_reply_to?: string;
  trace_id?: string;
  event_id?: number;
}

export function makeFrame(
  type: string,
  payload: Record<string, unknown> = {},
  opts: { inReplyTo?: string; traceId?: string; eventId?: number } = {},
): Frame {
  return {
    v: PROTOCOL_VERSION,
    id: `f-${randomUUID()}`,
    ts: Date.now(),
    type,
    payload,
    source: 'server',
    ...(opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {}),
    ...(opts.traceId ? { trace_id: opts.traceId } : {}),
    ...(opts.eventId !== undefined ? { event_id: opts.eventId } : {}),
  };
}

function envelopeError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'frame is not an object';
  const frame = value as Record<string, unknown>;
  if (frame.v !== PROTOCOL_VERSION) return `unsupported protocol version: ${String(frame.v)}`;
  if (typeof frame.id !== 'string' || !frame.id) return 'missing id';
  if (typeof frame.type !== 'string' || !frame.type) return 'missing type';
  if (typeof frame.ts !== 'number' || !Number.isFinite(frame.ts)) return 'missing ts';
  if (frame.payload !== undefined &&
      (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload))) {
    return 'payload must be an object';
  }
  return undefined;
}

export function decodeFrame(text: string, maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maxBytes) {
    return { ok: false as const, error: { code: 'frame_too_large', message: `${size}B exceeds ${maxBytes}B` } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false as const, error: { code: 'not_json', message: String(error) } };
  }
  const invalid = envelopeError(parsed);
  if (invalid) return { ok: false as const, error: { code: 'invalid_envelope', message: invalid } };
  const frame = parsed as Frame;
  return { ok: true as const, frame: { ...frame, payload: frame.payload ?? {} } };
}

export function ackTypeForCmd(type: string): string {
  return type.startsWith('cmd.') ? `ack.${type.slice(4)}` : 'ack.unknown';
}

export function errTypeForCmd(type: string): string {
  return type.startsWith('cmd.') ? `err.${type.slice(4)}` : 'err.unknown';
}
