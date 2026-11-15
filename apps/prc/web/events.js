// The runtime stores machine records — a plan update, a warning — in the same
// transcript as the agent's prose, as `MsgType.SystemEvent` (3) rows whose
// `msg_content` is JSON. Printing one verbatim dumps that JSON at the operator,
// so this module projects a record into what it actually describes. It is pure
// and shared with the node:test suite.
import { messageText } from './text.js';

const SYSTEM_EVENT = 3;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

// Records this console renders. Anything else is a trace for the desktop's own
// surfaces and is dropped rather than echoed.
const TODO_EVENT = 'todo_updated';
const WARNING_EVENT = 'runtime.warning';

// Returns what to show for a message, or `null` when it is ordinary text:
//   {kind: 'todos', todos}                  a plan the agent is working through
//   {kind: 'warning', text, code?}          something the runtime refused or lost
//   {kind: 'other', eventType}              a recognised record with no reader
export function eventRecord(message) {
  const declared = message?.msg_type === SYSTEM_EVENT;
  // A message that declares itself as prose is prose, whatever it contains.
  if (!declared && message?.msg_type !== undefined && message?.msg_type !== null) return null;

  const text = messageText(message).trim();
  // A record is one JSON object and nothing else; prose that merely mentions an
  // event type is left to the transcript.
  if (!text.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const eventType = typeof parsed.eventType === 'string' ? parsed.eventType : '';
  if (!eventType) return declared ? { kind: 'other', eventType: '' } : null;

  if (eventType === TODO_EVENT) {
    const todos = normalizeTodos(parsed.todos);
    // An empty list clears the panel on the desktop; a transcript has nothing to
    // show for it.
    return todos.length > 0 ? { kind: 'todos', todos } : { kind: 'other', eventType };
  }
  if (eventType === WARNING_EVENT) {
    const warning = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!warning) return { kind: 'other', eventType };
    const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : '';
    return code ? { kind: 'warning', text: warning, code } : { kind: 'warning', text: warning };
  }
  // Without the declared type, only a record we can render is a record: an
  // unrecognised JSON body may genuinely be part of an answer.
  return declared ? { kind: 'other', eventType } : null;
}

export function summarizeTodos(todos) {
  let completed = 0;
  let cancelled = 0;
  let remaining = 0;
  for (const todo of todos) {
    if (todo.status === 'completed') completed += 1;
    else if (todo.status === 'cancelled') cancelled += 1;
    else remaining += 1;
  }
  return { total: todos.length, completed, cancelled, remaining };
}

// The queue the desktop renders: content is required, an unknown status counts
// as not started yet, and priority is carried only when the producer set one.
function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  const todos = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) continue;
    const status = TODO_STATUSES.has(entry.status) ? entry.status : 'pending';
    const priority = typeof entry.priority === 'string' ? entry.priority.trim() : '';
    todos.push(priority ? { content, status, priority } : { content, status });
  }
  return todos;
}
