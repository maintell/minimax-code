import { isAbandonedStreamClosingMessage } from '@mavis/agent-core/protocol';
import { Role } from '@mavis/agent-core/protocol/agent-message';
/** Turns whose committed Assistant identities still wait for a Display row; oldest dropped past this. */
const MAX_WAITING_TURNS = 256;
/**
 * Links each committed canonical Assistant message to the Display row that
 * shows it (`canonical_message_id`), in order within a Turn. The two sides
 * arrive in either order: a text answer's Display row is written before its
 * message is committed, but an Assistant message with tool calls is committed
 * at its end while its Display row (send_to_user text included) is written
 * only after its tools finish. An identity committed before its row waits
 * here and is linked when the row arrives, never to an earlier row.
 */
export class CanonicalAssistantBoundaryLinker {
    options;
    waiting = new Map();
    constructor(options) {
        this.options = options;
    }
    /** A canonical commit: its Assistant identities wait for, or take, their Display rows. */
    async committed(input) {
        const ids = canonicalAssistantMessageIds(input.change);
        if (ids.length === 0)
            return;
        const key = turnKey(input.context);
        const queue = this.waiting.get(key) ?? [];
        this.waiting.delete(key);
        this.waiting.set(key, [...queue, ...ids]);
        if (this.waiting.size > MAX_WAITING_TURNS)
            this.waiting.delete(this.waiting.keys().next().value);
        await this.link(input.context);
    }
    /** A Display row of the Turn was written; a waiting identity may now take it. */
    async displayWritten(context) {
        if (this.waiting.get(turnKey(context))?.length)
            await this.link(context);
    }
    /**
     * The identity already linked to a Display row that is written again under
     * its msg_id, to spread into the rewrite. A PTC row is rewritten by each
     * tool-call chunk and then by its full message; its identity has left the
     * queue, so the rewrite must keep it.
     */
    async keptIdentity(sessionId, message) {
        if (!message.msg_id || !isCanonicalAssistantDisplayMessage(message))
            return {};
        try {
            const linked = (await this.options.messages.get(sessionId, message.msg_id))
                ?.canonical_message_id;
            return typeof linked === 'string' ? { canonical_message_id: linked } : {};
        }
        catch {
            return {};
        }
    }
    /**
     * Output review recalled the Turn's attempt and rewound its Display rows: an
     * identity still waiting belongs to the recalled output and will never get a
     * row, so it must not take a row of the regenerated reply.
     */
    recalled(context) {
        this.waiting.delete(turnKey(context));
    }
    async link(context) {
        try {
            const rows = (await this.options.messages.listTurn(context.sessionId, context.turnId)).filter(isCanonicalAssistantDisplayMessage);
            const open = rows.slice(afterLastLinked(rows));
            const key = turnKey(context);
            const queue = this.waiting.get(key) ?? [];
            // At most one side is ahead: pair the waiting identities with the newest open rows.
            const count = Math.min(queue.length, open.length);
            if (count === 0)
                return;
            const ids = queue.splice(0, count);
            if (queue.length === 0)
                this.waiting.delete(key);
            const targets = open.slice(-count);
            await Promise.all(targets.map((message, index) => this.options.messages.upsert({
                sessionId: context.sessionId,
                turnId: context.turnId,
                message: { ...message, canonical_message_id: ids[index] },
            })));
        }
        catch {
            // The canonical commit is authoritative. This Display-side Fork anchor is
            // best-effort and old rows retain the next-User compatibility boundary.
        }
    }
}
/** Index after the last row that already shows a committed identity. */
function afterLastLinked(rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1)
        if (typeof rows[index].canonical_message_id === 'string')
            return index + 1;
    return 0;
}
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
function canonicalAssistantMessageIds(change) {
    const messages = change.messages;
    const identities = change.committedIdentityVector;
    if (change.reason !== 'messageDelta' ||
        !messages ||
        !identities ||
        identities.length < messages.length) {
        return [];
    }
    const offset = identities.length - messages.length;
    return messages.flatMap((message, index) => {
        const identity = identities[offset + index];
        return message.role === Role.Assistant && typeof identity === 'string' && identity.length > 0
            ? [identity]
            : [];
    });
}
function isCanonicalAssistantDisplayMessage(message) {
    return (message.role === Role.Assistant &&
        !(typeof message.kind === 'string' && message.kind.length > 0) &&
        !(typeof message.displayKind === 'string' && message.displayKind.length > 0) &&
        !isAbandonedStreamClosingMessage(message));
}
//# sourceMappingURL=canonical-assistant-boundaries.js.map