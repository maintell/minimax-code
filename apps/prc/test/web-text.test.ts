import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, messageText } from '../web/text.js';

test('chunkText reads the runtime AgentMessageChunk a producer streams', () => {
  // RespData type 6 is what the bridge attaches to evt.session.message_chunk.
  assert.equal(
    chunkText({ type: 6, agent_message_chunk: { msg_id: 'm1', msg_content: 'hi' } }),
    'hi',
  );
  // A later delta with no text yet contributes nothing.
  assert.equal(chunkText({ type: 6, agent_message_chunk: { msg_id: 'm1', msg_content: '' } }), '');
});

test('chunkText still reads the legacy text and content-part shapes', () => {
  assert.equal(chunkText({ text: 'legacy' }), 'legacy');
  assert.equal(
    chunkText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }),
    'ab',
  );
});

test('chunkText returns an empty string rather than serialising the chunk', () => {
  for (const chunk of [undefined, null, 42, {}, { type: 6 }, { agent_message_chunk: { msg_content: 5 } }]) {
    assert.equal(chunkText(chunk), '');
  }
  // Non-text parts are skipped, not stringified.
  assert.equal(chunkText({ message: { content: [{ type: 'image' }] } }), '');
});

test('messageText reads an AgentMessage from history or evt.session.message', () => {
  assert.equal(messageText({ msg_id: 'm1', role: 'assistant', msg_content: 'hi' }), 'hi');
  assert.equal(
    messageText({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'ab',
  );
});

test('messageText returns an empty string for a message without text', () => {
  for (const message of [undefined, null, {}, { msg_id: 'm1', msg_content: 1 }, { content: [] }]) {
    assert.equal(messageText(message), '');
  }
});
