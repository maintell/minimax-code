/**
 * The envelope a cross-session message reaches the model in, and the note that
 * tells the receiver how an answer travels back.
 *
 * Split out of `local-turn-input-preparation.ts` to keep that module inside the
 * layout line budget; the wording and the behaviour are unchanged.
 */
/**
 * The stored message stays the original text. The model sees who sent it only
 * here, from the origin frozen at send time. A sender can otherwise close the
 * envelope and open a second one naming any session, so those tags are
 * neutralized inside the body.
 */
export function peerSessionEnvelope(messages, text, coordinator) {
    const origin = messages.map((message) => message.origin).find(isPeerSessionOrigin);
    if (!origin)
        return text;
    const title = origin.fromTitle?.trim();
    const device = origin.fromDevice?.trim();
    const attributes = [
        `from_session_id="${escapeXmlAttribute(origin.fromSession)}"`,
        ...(origin.fromAgent ? [`from_agent="${escapeXmlAttribute(origin.fromAgent)}"`] : []),
        ...(title ? [`from_title="${escapeXmlAttribute(title)}"`] : []),
        ...(device ? [`from_device="${escapeXmlAttribute(device)}"`] : []),
    ];
    const envelope = `<cross-session-message ${attributes.join(' ')}>\n${neutralizeEnvelope(text)}\n</cross-session-message>`;
    if (origin.remote === true)
        return `${envelope}\n${REMOTE_SENDER_REPLY_NOTE}`;
    return coordinator
        ? `${envelope}\n${COORDINATOR_REPLY_NOTE}`
        : `${envelope}\n${localSenderReplyNote(origin.fromSession)}`;
}
/**
 * Local sessions answer each other by sending back, so the receiver has to be
 * told the answer does not travel on its own. The last sentence stops the
 * acknowledgement ping-pong the 2026-11 cross-session eval (M3.1-Flash, M78)
 * saw: a reply is itself a cross-session message and carries this note too.
 */
function localSenderReplyNote(fromSession) {
    return `If this message needs an answer, send it with session_send to session_id ${fromSession}; text you write here does not reach the sender. Do not send thanks or acknowledgments.`;
}
/** A remote sender cannot be reached from this runtime; its reply is read back from here. */
const REMOTE_SENDER_REPLY_NOTE = 'The sender is a session on another device, so session_send cannot reach it. Reply directly in this conversation; the sender reads your reply from here.';
/**
 * A trusted coordinator has no `session_send`: its catalog hides the whole
 * session.dispatch group. Told to send its answer back, it searched for that
 * tool round after round and then probed the local API from bash.
 *
 * The sender decides which half applies, and input preparation cannot see it:
 * whether a peer session is a task this coordinator dispatched, or a
 * conversation the user created, is not among the origin facts frozen at send
 * time. So the note answers both — `assignment_send` reaches a task it
 * dispatched, and no tool reaches any other conversation — instead of telling
 * every sender's message that no answer can be sent, which left a task's
 * question waiting for a reply this coordinator does have a tool for.
 */
const COORDINATOR_REPLY_NOTE = 'If this message comes from a task you dispatched, reply with assignment_send. Other conversations cannot receive a reply from you; do not look for another tool to send one.';
/** Narrows the union only; trust was already decided in `createCanonicalUserInput`. */
function isPeerSessionOrigin(origin) {
    return (origin !== undefined &&
        'command' in origin &&
        origin.command === 'session send' &&
        origin.fromSession.trim().length > 0);
}
function neutralizeEnvelope(content) {
    return content.replace(/<\s*\/?\s*cross-session-message/gi, (tag) => tag.replace('<', '&lt;'));
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=peer-session-envelope.js.map