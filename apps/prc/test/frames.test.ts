import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_MESSAGE_BYTES, ackTypeForCmd, decodeFrame, errTypeForCmd, makeFrame,
} from '../src/frames.ts';

test('a well-formed envelope decodes', () => {
  const frame = makeFrame('ctrl.hello', { connection_id: 'c1' });
  const decoded = decodeFrame(JSON.stringify(frame));
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(decoded.frame.type, 'ctrl.hello');
});

test('malformed input is rejected without throwing', () => {
  const cases = [
    { body: '{"v":1,"ts":1,"type":"x"}', code: 'invalid_envelope', why: 'missing id' },
    { body: '{"v":1,"id":"a","ts":1}', code: 'invalid_envelope', why: 'missing type' },
    { body: '{"v":1,"id":"a","type":"x"}', code: 'invalid_envelope', why: 'missing ts' },
    { body: '{"v":2,"id":"a","ts":1,"type":"x"}', code: 'invalid_envelope', why: 'wrong version' },
    { body: '{"v":1,"id":"a","ts":1,"type":"x","payload":[]}', code: 'invalid_envelope', why: 'array payload' },
    { body: 'null', code: 'invalid_envelope', why: 'null body' },
    { body: '[]', code: 'invalid_envelope', why: 'array body' },
    { body: '"x"', code: 'invalid_envelope', why: 'string body' },
    { body: 'not json', code: 'not_json', why: 'unparsable text' },
  ];
  for (const { body, code, why } of cases) {
    const decoded = decodeFrame(body);
    assert.equal(decoded.ok, false, why);
    if (!decoded.ok) assert.equal(decoded.error.code, code, why);
  }
});

test('oversized frames report frame_too_large', () => {
  const frame = makeFrame('evt.test', { blob: 'x'.repeat(64) });
  const decoded = decodeFrame(JSON.stringify(frame), 32);
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.error.code, 'frame_too_large');
});

test('the size cap is inclusive and one byte over is rejected', () => {
  const text = JSON.stringify(makeFrame('evt.boundary', { blob: 'x'.repeat(32) }));
  const size = Buffer.byteLength(text, 'utf8');
  assert.equal(decodeFrame(text, size).ok, true);
  const tooLarge = decodeFrame(text, size - 1);
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, 'frame_too_large');
});

test('ack and err types mirror the command domain', () => {
  assert.equal(ackTypeForCmd('cmd.session.send'), 'ack.session.send');
  assert.equal(errTypeForCmd('cmd.session.send'), 'err.session.send');
  assert.equal(ackTypeForCmd('nonsense'), 'ack.unknown');
  assert.equal(errTypeForCmd('nonsense'), 'err.unknown');
});

test('outbound frames stamp source, event id and reply linkage', () => {
  const frame = makeFrame('ack.session.send', {}, { inReplyTo: 'cmd-1', traceId: 'trace-1', eventId: 7 });
  assert.equal(frame.source, 'server');
  assert.equal(frame.event_id, 7);
  assert.equal(frame.in_reply_to, 'cmd-1');
  assert.equal(frame.trace_id, 'trace-1');
  assert.equal(frame.v, 1);
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 128 * 1024 * 1024);
});

test('makeFrame omits absent linkage fields and mints unique ids', () => {
  const frame = makeFrame('ctrl.ping');
  assert.equal('in_reply_to' in frame, false);
  assert.equal('trace_id' in frame, false);
  assert.equal('event_id' in frame, false);

  const first = makeFrame('ctrl.ping');
  const second = makeFrame('ctrl.ping');
  assert.notEqual(first.id, second.id);
});
