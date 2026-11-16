// DOM for one transcript row. Kept apart from app.js so the wiring code stays
// about state and sockets while this file stays about shapes. Every node here is
// built from data the console already trusts; the only innerHTML uses are this
// module's own icon constants and the sanitized output of markdown.js.
import { renderMarkdown } from './markdown.js';
import { rowView } from './view.js';
import { summarizeTodos } from './events.js';

const MARKERS = { pending: '○', in_progress: '●', completed: '✓', cancelled: '–' };
const STATUS_WORDS = {
  pending: 'pending', in_progress: 'in progress', completed: 'completed', cancelled: 'cancelled',
};
const CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

// One message, and everything the desktop recorded around it: the rows that
// surround an answer are as much a part of the turn as the answer itself.
export function renderRow(message) {
  const view = rowView(message);
  if (view.record !== null) return renderRecord(view.record);

  const nodes = [];
  if (view.thoughtSeconds || view.tools.length > 0) {
    nodes.push(activityRow(view.thoughtSeconds, view.tools));
  }
  if (view.mediaCount > 0) {
    const count = view.mediaCount === 1 ? '1 attachment' : `${view.mediaCount} attachments`;
    const line = document.createElement('p');
    line.className = 'attachments';
    line.textContent = count;
    line.title = 'Attachments are not available in the console yet.';
    nodes.push(line);
  }
  if (view.text) {
    nodes.push(view.role === 'user' ? userBubble(view.text) : markdownBlock(view.text));
  }
  return nodes;
}

// Machine records: a plan is a list, a warning is a sentence, anything else has
// no surface here and contributes no row.
export function renderRecord(record) {
  if (record.kind === 'todos') return [planCard(record.todos)];
  if (record.kind === 'warning') return [warningRow(record.text, record.code)];
  return [];
}

export function userBubble(text) {
  const row = document.createElement('div');
  row.className = 'row-user';
  row.textContent = text;
  return row;
}

export function markdownBlock(text) {
  const row = document.createElement('div');
  row.className = 'row-ai md';
  row.innerHTML = renderMarkdown(text);
  return row;
}

// The answer arrives as chunks before it is complete; until then it is plain
// text, and the completed row replaces it with the rendered version.
export function streamingBubble() {
  const row = document.createElement('div');
  row.className = 'row-ai stream';
  return row;
}

export function activityRow(thoughtSeconds, tools) {
  const details = document.createElement('details');
  details.className = 'activity';
  const summary = document.createElement('summary');
  const parts = [];
  if (thoughtSeconds) parts.push(`Thought for ${thoughtSeconds}`);
  if (tools.length > 0) parts.push(`used ${tools.length === 1 ? '1 tool' : `${tools.length} tools`}`);
  summary.append(document.createTextNode(parts.join(', ')));
  summary.insertAdjacentHTML('beforeend', CHEVRON);
  const body = document.createElement('div');
  body.className = 'activity-body';
  for (const tool of tools) {
    const line = document.createElement('div');
    line.className = 'tool-line';
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = tool.name;
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    detail.textContent = tool.detail;
    line.append(name, detail);
    body.append(line);
  }
  // Reasoning text itself is not part of the transcript; the row reports that it
  // happened, not what it said.
  if (tools.length === 0) {
    const note = document.createElement('div');
    note.textContent = 'The agent reasoned through this step.';
    body.append(note);
  }
  details.append(summary, body);
  return details;
}

export function planCard(todos) {
  const counts = summarizeTodos(todos);
  const details = document.createElement('details');
  details.className = counts.remaining > 0 ? 'plan' : 'plan finished';
  // A plan the operator can act on stands open; a finished one is a single line.
  details.open = counts.remaining > 0;
  const summary = document.createElement('summary');
  summary.append(document.createTextNode(`Todo list ${counts.completed}/${counts.total}`));
  summary.insertAdjacentHTML('beforeend', CHEVRON);
  const body = document.createElement('div');
  body.className = 'plan-body';
  const list = document.createElement('ol');
  for (const todo of todos) {
    const item = document.createElement('li');
    item.className = todo.status;
    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = MARKERS[todo.status] ?? MARKERS.pending;
    marker.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.textContent = `${STATUS_WORDS[todo.status] ?? 'pending'}: `;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = todo.content;
    item.append(marker, status, text);
    list.append(item);
  }
  body.append(list);
  details.append(summary, body);
  return details;
}

export function warningRow(text, code) {
  const row = document.createElement('div');
  row.className = 'warning';
  row.setAttribute('role', 'status');
  row.textContent = text;
  // The code is what support would ask for; it stays out of the sentence.
  if (code) row.title = code;
  return row;
}

export function notice(text) {
  const row = document.createElement('div');
  row.className = 'notice';
  row.textContent = text;
  return row;
}
