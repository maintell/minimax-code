import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventRecord, summarizeTodos } from '../web/events.js';

// What the desktop stores for a plan update: a `MsgType.SystemEvent` row whose
// content is the event itself, not prose.
const SYSTEM_EVENT = 3;

function record(content: string): { msg_type: number; msg_content: string } {
  return { msg_type: SYSTEM_EVENT, msg_content: content };
}

test('a plan update becomes a todo list instead of the JSON it arrived as', () => {
  const todos = [
    { content: 'Locate the private frame in memory', status: 'completed', priority: 'high' },
    { content: 'Capture an arm64 trace on the device', status: 'in_progress', priority: 'high' },
    { content: 'Reimplement the KDF in Go', status: 'pending', priority: 'high' },
  ];
  const message = record(JSON.stringify({ eventType: 'todo_updated', todos }));
  assert.deepEqual(eventRecord(message), { kind: 'todos', todos });
});

test('todo items are normalised the way the desktop reads them', () => {
  const message = record(JSON.stringify({
    eventType: 'todo_updated',
    todos: [
      { content: '  shipped  ', status: 'cancelled' },
      { content: 'unknown state', status: 'blocked' },
      { content: '', status: 'pending' },
      { status: 'pending' },
      { content: 'started', status: 'in_progress', priority: '' },
      null,
      'text',
    ],
  }));
  assert.deepEqual(eventRecord(message), {
    kind: 'todos',
    todos: [
      { content: 'shipped', status: 'cancelled' },
      { content: 'unknown state', status: 'pending' },
      { content: 'started', status: 'in_progress' },
    ],
  });
});

test('an empty plan leaves the transcript alone', () => {
  assert.deepEqual(eventRecord(record(JSON.stringify({ eventType: 'todo_updated', todos: [] }))), {
    kind: 'other',
    eventType: 'todo_updated',
  });
  assert.deepEqual(eventRecord(record(JSON.stringify({ eventType: 'todo_updated' }))), {
    kind: 'other',
    eventType: 'todo_updated',
  });
});

test('a runtime warning is read as its sentence, with its code kept aside', () => {
  const warning = record(JSON.stringify({
    eventType: 'runtime.warning',
    message: 'The model rejected the request.',
    source: 'local-runtime',
    code: 'provider_error',
  }));
  assert.deepEqual(eventRecord(warning), {
    kind: 'warning',
    text: 'The model rejected the request.',
    code: 'provider_error',
  });
  // A warning without a code has nothing to put aside.
  assert.deepEqual(eventRecord(record(JSON.stringify({ eventType: 'runtime.warning', message: 'Hi' }))), {
    kind: 'warning',
    text: 'Hi',
  });
});

test('records the console has no surface for are consumed, not printed', () => {
  for (const eventType of ['execution.diagnostic', 'session.spawned', 'delegation.message']) {
    assert.deepEqual(eventRecord(record(JSON.stringify({ eventType, detail: { step: 1 } }))), {
      kind: 'other',
      eventType,
    });
  }
  // A system row that is not JSON at all stays visible as text.
  assert.equal(eventRecord(record('the plan is unchanged')), null);
  assert.equal(eventRecord(record('{"broken": ')), null);
});

test('prose is never mistaken for a record', () => {
  assert.equal(eventRecord({ msg_type: 2, msg_content: 'the todos are done' }), null);
  assert.equal(eventRecord({ msg_key: 'x', content: [{ type: 'text', text: 'hello' }] }), null);
  // An answer may legitimately quote an event payload; it is still an answer.
  const quoted = JSON.stringify({ eventType: 'todo_updated', todos: [{ content: 'x', status: 'pending' }] });
  assert.equal(eventRecord({ msg_type: 2, msg_content: quoted }), null);
  // Without a declared type only a renderable record is a record.
  assert.equal(eventRecord({ msg_content: JSON.stringify({ eventType: 'execution.diagnostic' }) }), null);
  assert.deepEqual(eventRecord({ msg_content: quoted }), {
    kind: 'todos',
    todos: [{ content: 'x', status: 'pending' }],
  });
});

test('empty and non-string bodies are not records', () => {
  for (const message of [undefined, null, {}, { msg_type: SYSTEM_EVENT }, { msg_content: 7 }]) {
    assert.equal(eventRecord(message), null);
  }
});

test('the summary counts what is done and what is left', () => {
  const todos = [
    { content: 'a', status: 'completed' as const },
    { content: 'b', status: 'completed' as const },
    { content: 'c', status: 'cancelled' as const },
    { content: 'd', status: 'in_progress' as const },
    { content: 'e', status: 'pending' as const },
  ];
  assert.deepEqual(summarizeTodos(todos), { total: 5, completed: 2, cancelled: 1, remaining: 2 });
  assert.deepEqual(summarizeTodos([]), { total: 0, completed: 0, cancelled: 0, remaining: 0 });
});
