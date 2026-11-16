import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSeconds, relativeTime, rowView, sessionStamp, stripProductMarkup, workspaceName } from '../web/view.js';

// A row that is prose, narrowed for the type checker: the record branch carries
// none of these fields.
function prose(message: unknown) {
  const view = rowView(message);
  if (view.record !== null) throw new Error('expected a prose row');
  return view;
}

test('a user message keeps its text and nothing else', () => {
  const view = prose({ role: 'user', msg_content: 'ship it' });
  assert.equal(view.role, 'user');
  assert.equal(view.text, 'ship it');
  assert.deepEqual(view.tools, []);
  assert.equal(view.thoughtSeconds, null);
});

test('a machine record is reported as a record, not as prose', () => {
  const view = rowView({
    msg_type: 3,
    msg_content: JSON.stringify({ eventType: 'todo_updated', todos: [{ content: 'a', status: 'pending' }] }),
  });
  assert.equal(view.record?.kind, 'todos');
});

test('product markup is stripped and counted, never rendered', () => {
  const text = [
    'Here is the file.',
    '<deliver-assets>',
    '<media type="file" src="D:/x/a.md" caption="a" />',
    '<media src="D:/x/b.png" />',
    '</deliver-assets>',
    'Thanks.',
  ].join('\n');
  const stripped = stripProductMarkup(text);
  assert.equal(stripped.mediaCount, 2);
  assert.equal(stripped.text, 'Here is the file.\n\nThanks.');
  // A lone media tag outside the wrapper still counts.
  assert.deepEqual(stripProductMarkup('x <media src="a" /> y'), { text: 'x  y', mediaCount: 1 });
  assert.deepEqual(stripProductMarkup(undefined), { text: '', mediaCount: 0 });
});

test('tool calls become one readable line each', () => {
  const view = prose({
    role: 'assistant',
    msg_content: '',
    tool_calls: [
      { tool_name: 'read_file', tool_call_status: 2, tool_call_args: '{"path":"D:/a/b.ts"}' },
      { tool_name: 'run_code', tool_call_status: 1, tool_call_args: '{"code":"import os\\nprint(1)"}' },
      { tool_name: 'search', tool_call_args: 'plain text query' },
      { tool_name: '', tool_call_status: 9 },
      null,
    ],
  });
  assert.deepEqual(view.tools, [
    { name: 'read_file', detail: 'D:/a/b.ts', status: 'done' },
    { name: 'run_code', detail: 'import os print(1)', status: '' },
    { name: 'search', detail: 'plain text query', status: '' },
    { name: 'tool', detail: '', status: '' },
  ]);
});

test('a long argument preview is cut instead of wrapping', () => {
  const view = prose({
    role: 'assistant',
    tool_calls: [{ tool_name: 'run', tool_call_args: JSON.stringify({ command: 'x'.repeat(200) }) }],
  });
  assert.equal(view.tools[0].detail.length, 64);
  assert.ok(view.tools[0].detail.endsWith('…'));
});

test('thinking time is reported in seconds, never as the trace', () => {
  assert.equal(prose({ role: 'assistant', thinking_duration_ms: 6249 }).thoughtSeconds, '6s');
  assert.equal(prose({ role: 'assistant', thinking_duration_ms: 120_000 }).thoughtSeconds, '2m');
  assert.equal(prose({ role: 'assistant', thinking_duration_ms: 0 }).thoughtSeconds, null);
  assert.equal(formatSeconds(400), '<1s');
  assert.equal(formatSeconds(90_500), '1m 31s');
});

test('session stamps read as age, not as iso strings', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(relativeTime('2026-11-16T11:59:40Z', now), 'now');
  assert.equal(relativeTime('2026-11-16T11:35:00Z', now), '25m');
  assert.equal(relativeTime('2026-11-16T06:00:00Z', now), '6h');
  assert.equal(relativeTime('2026-11-13T12:00:00Z', now), '3d');
  assert.equal(relativeTime('', now), '');
  assert.equal(relativeTime('not a date', now), '');
});

test('a session without a usable timestamp shows nothing', () => {
  assert.equal(sessionStamp({ id: 's1' }), '');
  // Relative to the real clock: `sessionStamp` reads "now" from the running system.
  assert.equal(sessionStamp({ id: 's1', last_msg_at_ms: Date.now() - 3_600_000 }), '1h');
});

test('a session is grouped by the folder it works in', () => {
  assert.equal(workspaceName({ workspace_dir: 'D:\\weCom' }), 'weCom');
  assert.equal(workspaceName({ workspace_dir: '/home/me/code/api/' }), 'api');
  assert.equal(workspaceName({ workspace_dir: 'D:/' }), 'D:');
  assert.equal(workspaceName({}), '');
  assert.equal(workspaceName({ workspace_dir: 42 }), '');
});
