import { isUserMessageId } from '../../../session-system/index.js';
import { prepareSteeringTeardownCanonicalInput } from '../../agent-host/assembly/local-turn-input-preparation.js';
export function createSteeringTeardownCommit(options) {
    return {
        async commit({ sessionId, turnId, messages, onCommitted }) {
            // Retries re-enter here after a partial failure: the identity vector
            // lets already-appended rows be skipped instead of throwing on the
            // duplicate-identity boundary. An unreadable vector degrades to the
            // per-append duplicate tolerance below.
            const identityVector = await readIdentityVector(options, sessionId);
            for (const message of messages) {
                try {
                    await options.projectDisplay({ sessionId, turnId, message });
                    await appendCanonicalUserRow(options, { sessionId, turnId, message, identityVector });
                }
                catch (error) {
                    options.logger?.warn({
                        sessionId,
                        turnId,
                        producerId: message.producerId,
                        idempotencyKey: message.idempotencyKey,
                        error: `${error}`,
                    }, 'Steering teardown could not commit a message into the conversation');
                    // Stop at the first failure so a retry preserves the send order.
                    return false;
                }
                reportCommitted(onCommitted, message);
                await reportDurable(options, { sessionId, turnId, message });
            }
            return true;
        },
    };
}
/** Progress observers are advisory; their failure never undoes a durable commit. */
function reportCommitted(onCommitted, message) {
    try {
        onCommitted?.(message);
    }
    catch {
        // The message is durable either way; the observer only trims fallbacks.
    }
}
async function reportDurable(options, input) {
    try {
        await options.onMessageDurable?.(input);
    }
    catch (error) {
        // Both rows are already durable; an owner bookkeeping failure must not
        // turn a successful commit into a retry that duplicates the message.
        options.logger?.warn({
            sessionId: input.sessionId,
            turnId: input.turnId,
            producerId: input.message.producerId,
            idempotencyKey: input.message.idempotencyKey,
            error: `${error}`,
        }, 'Steering teardown durable-commit observer failed');
    }
}
async function readIdentityVector(options, sessionId) {
    try {
        return (await options.canonicalHistory.inspectActive(sessionId)).identityVector;
    }
    catch {
        return undefined;
    }
}
async function appendCanonicalUserRow(options, input) {
    const userMessageId = hintedUserMessageId(input.message);
    if (userMessageId && input.identityVector?.includes(userMessageId))
        return;
    try {
        await options.canonicalHistory.append(teardownAppendChange(options, input, userMessageId));
    }
    catch (error) {
        // A duplicated append identity means the row is already durable — a
        // retry after a partial display/canonical failure must not throw here.
        if (isDuplicateIdentityError(error))
            return;
        throw error;
    }
}
/** Only a well-formed display id may become a `display-user` identity hint. */
function hintedUserMessageId(message) {
    return message.userMessageId !== undefined && isUserMessageId(message.userMessageId)
        ? message.userMessageId
        : undefined;
}
function teardownAppendChange(options, input, userMessageId) {
    const { message } = input;
    // Same canonical conversion as the consumption path: quoted-message text
    // rendering, the attachment reminder with exact paths, and any inline
    // data-URL images the message already carries (Decision v5, TS-74).
    const canonical = prepareSteeringTeardownCanonicalInput({
        message: message.message,
        provenance: message.provenance,
    });
    const row = {
        role: 'user',
        content: [{ type: 'text', text: canonical.text }, ...canonical.attachments],
        timestamp: message.createdAt ?? options.nowMs?.() ?? Date.now(),
        ...(message.genuineUserQueryText !== undefined
            ? { genuineUserQueryText: message.genuineUserQueryText }
            : {}),
    };
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: 'messageDelta',
        messages: [row],
        ...(userMessageId
            ? { identityHints: [{ index: 0, messageId: userMessageId, source: 'display-user' }] }
            : {}),
        operation: {
            id: `steering-teardown:${input.turnId}:${message.producerId}:${message.idempotencyKey}`,
            kind: 'steering-teardown',
        },
    };
}
function isDuplicateIdentityError(error) {
    return error instanceof TypeError && /identity is duplicated/.test(error.message);
}
//# sourceMappingURL=steering-teardown-commit.js.map