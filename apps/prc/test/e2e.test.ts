import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProducerDouble } from './fixtures/producer-double.ts';
import { startPrc } from './fixtures/prc-harness.ts';
import { chunkText } from '../web/text.js';

test('a bridged producer completes a turn through PRC', async () => {
  const prc = await startPrc({ password: 'e2e' });
  let producer: { stop(): Promise<void> } | undefined;
  try {
    producer = await startProducerDouble({ prcUrl: prc.url, password: 'e2e' });
    const login = await prc.login('e2e');
    assert.ok(login.csrf);
    const state = await prc.get('/api/state', { headers: { 'x-device-id': 'dev-e2e' } });
    assert.equal(state.binding.deviceId, 'dev-e2e');

    const socket = await prc.openSocket();
    socket.send(JSON.stringify({ kind: 'cmd', requestId: 'r1', type: 'session.send', payload: { session_id: 's1', content: 'hello' } }));
    const ack = await socket.next((message) => message.requestId === 'r1');
    assert.equal(ack.kind, 'ack');

    const chunk = await socket.next((message) => message.type === 'evt.session.message_chunk');
    assert.equal(chunk.payload.session_id, 's1');
    // The double emits the runtime's real chunk, so the console's own parser is
    // what has to turn it into text.
    assert.equal(chunkText(chunk.payload.chunk), 'hi');
    const end = await socket.next((message) => message.type === 'evt.session.turn_end');
    assert.equal(end.payload.status, 'finished');
  } finally {
    // A failed assertion must not leave the server, producer socket, SQLite
    // store and temp dir open, or the runner never exits.
    try {
      await producer?.stop();
    } finally {
      await prc.close();
    }
  }
});
