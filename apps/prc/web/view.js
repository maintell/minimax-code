// What a transcript row means, independent of how it is drawn. The socket, the
// history page and the composer's optimistic echo all describe the same thing,
// so they share one projection. Pure, and shared with the node:test suite.
import { eventRecord } from './events.js';
import { messageText } from './text.js';

// The console has no attachment route yet (README §M1 limits), so a row that
// points at media keeps a count instead of the markup it arrived with.
const ASSET_BLOCK = /<deliver-assets>[\s\S]*?<\/deliver-assets>/giu;
const MEDIA_TAG = /<media\b[^>]*>/giu;

// Tool arguments are a JSON string whose first useful field is what identifies
// the call: a path, a command, a query. Anything larger is noise in a one-line
// summary.
const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'path', 'query', 'url', 'pattern', 'code'];

export function rowView(message) {
  const record = eventRecord(message);
  if (record !== null) return { record };
  const { text, mediaCount } = stripProductMarkup(messageText(message));
  return {
    record: null,
    role: message?.role === 'user' ? 'user' : 'assistant',
    text,
    mediaCount,
    tools: toolCalls(message),
    thoughtSeconds: thoughtSeconds(message),
  };
}

export function stripProductMarkup(text) {
  let mediaCount = 0;
  if (typeof text !== 'string' || text === '') return { text: '', mediaCount };
  const withoutAssets = text.replace(ASSET_BLOCK, (block) => {
    mediaCount += block.match(MEDIA_TAG)?.length ?? 0;
    return '';
  });
  const withoutMedia = withoutAssets.replace(MEDIA_TAG, () => {
    mediaCount += 1;
    return '';
  });
  return { text: withoutMedia.replace(/\n{3,}/gu, '\n\n').trim(), mediaCount };
}

// `tool_call_status` is a producer enum; 2 is the settled success we can name.
// Any other value is left unlabelled rather than guessed at.
export function toolCalls(message) {
  const list = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const tools = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    tools.push({
      name: typeof entry.tool_name === 'string' && entry.tool_name ? entry.tool_name : 'tool',
      detail: argPreview(entry.tool_call_args),
      status: entry.tool_call_status === 2 ? 'done' : '',
    });
  }
  return tools;
}

export function thoughtSeconds(message) {
  const ms = message?.thinking_duration_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return formatSeconds(ms);
}

// Seconds, because a whole minute of reasoning is still one number to read.
export function formatSeconds(ms) {
  const seconds = ms / 1000;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

// A session row shows when it last moved, so the operator can tell a live
// session from one that was finished days ago.
export function relativeTime(value, now = Date.now()) {
  const stamp = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const seconds = Math.max(0, Math.round((now - stamp) / 1000));
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function sessionStamp(session) {
  for (const key of ['updated_at', 'updatedAt', 'last_message_at', 'lastMessageAt', 'created_at', 'createdAt']) {
    const value = session?.[key];
    if (value === undefined || value === null) continue;
    const label = relativeTime(value);
    if (label) return label;
  }
  return '';
}

// The first line of the arguments that names the call; `code` and `command`
// payloads are multi-line by nature.
function argPreview(args) {
  let parsed = args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed === '') return '';
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return oneLine(trimmed);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof parsed === 'string' ? oneLine(parsed) : '';
  }
  for (const key of DETAIL_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return '';
}

function oneLine(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
}
