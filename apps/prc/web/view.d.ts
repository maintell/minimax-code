import type { EventRecord } from './events.js';

export type RowRole = 'user' | 'assistant';

export interface ToolCallView {
  name: string;
  detail: string;
  status: string;
}

/** A machine record: it has no prose of its own. */
export interface RecordRow {
  record: EventRecord;
}

/** Everything else the transcript shows: text plus the activity around it. */
export interface ProseRow {
  record: null;
  role: RowRole;
  text: string;
  mediaCount: number;
  tools: ToolCallView[];
  thoughtSeconds: string | null;
}

export type RowView = RecordRow | ProseRow;

export function rowView(message: unknown): RowView;
export function stripProductMarkup(text: unknown): { text: string; mediaCount: number };
export function toolCalls(message: unknown): ToolCallView[];
export function thoughtSeconds(message: unknown): string | null;
export function formatSeconds(ms: number): string;
export function relativeTime(value: unknown, now?: number): string;
export function sessionStamp(session: unknown): string;
