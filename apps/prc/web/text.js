// The producer forwards the runtime's own stream objects verbatim, so the text
// of an assistant turn lives in a different field depending on which frame
// carried it. Both helpers are pure and shared with the node:test suite.

// `evt.session.message_chunk` carries a RespData envelope: the runtime's
// AgentMessageChunk is type 6 and its text is `agent_message_chunk.msg_content`.
// Reasoning arrives on the same frame as `thinking_content`; it is progress, not
// the answer, so the transcript shows a placeholder instead of the raw trace.
export function chunkText(chunk) {
  if (typeof chunk?.text === 'string') return chunk.text;
  const streamed = chunk?.agent_message_chunk?.msg_content;
  if (typeof streamed === 'string') return streamed;
  const content = chunk?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

export function chunkThinking(chunk) {
  const thinking = chunk?.agent_message_chunk?.thinking_content;
  return typeof thinking === 'string' ? thinking : '';
}

// `evt.session.message` and stored history rows are AgentMessage objects, whose
// text is `msg_content`; a message body can also arrive as content parts.
export function messageText(message) {
  if (typeof message?.msg_content === 'string') return message.msg_content;
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}
