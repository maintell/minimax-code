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

test('missing ts, wrong version and non-object payload are rejected without throwing', () => {
  assert.equal(decodeFrame('{"v":1,"id":"a","type":"x"}').ok, false);
  assert.equal(decodeFrame('{"v":2,"id":"a","ts":1,"type":"x"}').ok, false);
  assert.equal(decodeFrame('{"v":1,"id":"a","ts":1,"type":"x","payload":[]}').ok, false);
  assert.equal(decodeFrame('not json').ok, false);
});

test('oversized frames report frame_too_large', () => {
  const frame = makeFrame('evt.test', { blob: 'x'.repeat(64) });
  const decoded = decodeFrame(JSON.stringify(frame), 32);
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.error.code, 'frame_too_large');
});

test('ack and err types mirror the command domain', () => {
  assert.equal(ackTypeForCmd('cmd.session.send'), 'ack.session.send');
  assert.equal(errTypeForCmd('cmd.session.send'), 'err.session.send');
  assert.equal(ackTypeForCmd('nonsense'), 'ack.unknown');
});

test('outbound frames stamp source, event id and reply linkage', () => {
  const frame = makeFrame('ack.session.send', {}, { inReplyTo: 'cmd-1', eventId: 7 });
  assert.equal(frame.source, 'server');
  assert.equal(frame.event_id, 7);
  assert.equal(frame.in_reply_to, 'cmd-1');
  assert.equal(frame.v, 1);
  assert.ok(DEFAULT_MAX_MESSAGE_BYTES >= 128 * 1024 * 1024);
});
