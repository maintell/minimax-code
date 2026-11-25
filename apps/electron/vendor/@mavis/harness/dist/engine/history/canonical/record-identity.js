import { sha256Base64Url } from './canonical-record.js';
import { preserveHistoryArtifact } from './generation-marker.js';
const USER_MESSAGE_ID = /^msg-user-v1-[A-Za-z0-9_-]+$/u;
export function isUserMessageId(value) {
    return typeof value === 'string' && USER_MESSAGE_ID.test(value);
}
export function assertCanonicalRecordChange(change, reason) {
    if (change.reason !== reason || !change.operation.id.trim()) {
        throw new TypeError(`Canonical history ${reason} change is invalid.`);
    }
}
/** Appended records: hinted identities are kept, the rest derive from the operation. */
export function planAppendRecords(change) {
    const identityHints = appendIdentityHints(change);
    return change.messages.map((message, index) => canonicalRecord({
        change,
        message,
        turnId: change.turnId,
        index,
        identityHint: identityHints.get(index),
    }));
}
function appendIdentityHints(change) {
    const hints = new Map();
    for (const hint of change.identityHints ?? []) {
        if (!Number.isSafeInteger(hint.index) ||
            hint.index < 0 ||
            hint.index >= change.messages.length) {
            throw new TypeError(`Canonical history identity hint index is invalid: ${String(hint.index)}`);
        }
        if (hints.has(hint.index)) {
            throw new TypeError(`Canonical history identity hint index is duplicated: ${String(hint.index)}`);
        }
        assertAppendIdentityHint(hint, canonicalHistoryMessage(change.messages[hint.index]));
        hints.set(hint.index, hint);
    }
    if (new Set([...hints.values()].map(({ messageId }) => messageId)).size !== hints.size) {
        throw new TypeError('Canonical history identity hint message id is duplicated.');
    }
    return hints;
}
function assertAppendIdentityHint(hint, message) {
    if (!hint.messageId.trim() || !/^msg-.+/u.test(hint.messageId)) {
        throw new TypeError('Canonical history identity hint message id is invalid.');
    }
    if (hint.source === 'display-user') {
        if (message.role !== 'user' || !isUserMessageId(hint.messageId)) {
            throw new TypeError('Canonical display user identity hint is invalid.');
        }
        return;
    }
    if (hint.source !== 'preserved' && hint.source !== 'internal-new') {
        throw new TypeError('Canonical history identity hint source is invalid.');
    }
    if (hint.source === 'internal-new' && isUserMessageId(hint.messageId)) {
        throw new TypeError('Canonical internal identity cannot use an external user id.');
    }
}
/** Appended identities must be new to the history and distinct among themselves. */
export function assertAppendIdentityBoundary(existing, appended) {
    const identities = new Set(existing.map(({ message_id }) => message_id));
    for (const { message_id } of appended) {
        if (identities.has(message_id)) {
            throw new TypeError(`Canonical history append identity is duplicated: ${message_id}`);
        }
        identities.add(message_id);
    }
}
/** A replacement names every identity; a missing or partial plan fails closed. */
export function planReplacementRecords(change, existing) {
    const entries = change.replacementEntries;
    if (!entries || entries.length !== change.messages.length) {
        throw new TypeError('Canonical history replacement identity plan is required.');
    }
    const existingById = new Map();
    for (const record of existing) {
        if (existingById.has(record.message_id)) {
            throw new TypeError(`Canonical history contains duplicate message id: ${record.message_id}`);
        }
        existingById.set(record.message_id, record);
    }
    const used = new Set();
    const replacement = entries.map((entry, index) => {
        const normalized = canonicalHistoryMessage(entry.message);
        const { messageId, previous } = resolveReplacementIdentity({
            entry,
            normalized,
            existingById,
            change,
            index,
        });
        if (used.has(messageId))
            throw new TypeError(`Canonical history replacement identity is duplicated: ${messageId}`);
        used.add(messageId);
        return {
            ...(previous ?? {}),
            message_id: messageId,
            turn_id: previous?.turn_id ??
                (normalized.role === 'user' ? `${change.turnId}:${String(index)}` : change.turnId),
            message: normalized,
        };
    });
    return preserveHistoryArtifact(existing, replacement);
}
function resolveReplacementIdentity(input) {
    const { entry } = input;
    if (entry.identity.kind === 'preserve') {
        const previous = input.existingById.get(entry.identity.messageId);
        if (!previous) {
            throw new TypeError(`Canonical history identity is missing: ${entry.identity.messageId}`);
        }
        return { messageId: entry.identity.messageId, previous };
    }
    if (entry.identity.kind === 'external-user') {
        assertExternalUserIdentity(entry.identity.messageId, input.normalized, input.existingById);
        return { messageId: entry.identity.messageId };
    }
    if (!entry.identity.seed.trim()) {
        throw new TypeError('Canonical history new identity seed is required.');
    }
    return {
        messageId: messageIdFromSeed(`${input.change.operation.id}:${entry.identity.seed}:${String(input.index)}`),
    };
}
function assertExternalUserIdentity(messageId, message, existingById) {
    if (message.role !== 'user' || !isUserMessageId(messageId)) {
        throw new TypeError(`External user identity requires a user message: ${messageId}`);
    }
    if (existingById.has(messageId)) {
        throw new TypeError(`External user identity already exists; use preserve: ${messageId}`);
    }
}
/** A new record whose identity derives from the operation, the position, and the message. */
export function canonicalRecord(input) {
    const normalized = canonicalHistoryMessage(input.message);
    return {
        message_id: input.identityHint?.messageId ??
            (input.change.operation.kind === 'worktree-reminder'
                ? `msg-control-${sha256Base64Url(`${input.change.operation.id}:${String(input.index)}`)}`
                : messageIdFromSeed(`${input.change.operation.id}:${String(input.index)}:${JSON.stringify(normalized)}`)),
        turn_id: input.turnId,
        message: normalized,
    };
}
export function messageIdFromSeed(seed) {
    return `msg-${sha256Base64Url(seed)}`;
}
/** A Pi message with a role and a finite timestamp, or the minimal native compaction summary. */
export function canonicalHistoryMessage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Canonical history contains a non-object message.');
    }
    const minimal = readMinimalCompactionSummary(value);
    if (minimal)
        return minimal;
    const role = Reflect.get(value, 'role');
    const timestamp = Reflect.get(value, 'timestamp');
    if (typeof role !== 'string' ||
        !role ||
        typeof timestamp !== 'number' ||
        !Number.isFinite(timestamp)) {
        throw new TypeError('Canonical history contains an invalid Pi message.');
    }
    return value;
}
function readMinimalCompactionSummary(value) {
    if (Reflect.get(value, 'role') !== 'compactionSummary')
        return undefined;
    const summary = Reflect.get(value, 'summary');
    if (typeof summary !== 'string' ||
        Object.hasOwn(value, 'timestamp') ||
        Object.hasOwn(value, 'tokensBefore') ||
        Object.keys(value).some((key) => key !== 'role' && key !== 'summary')) {
        return undefined;
    }
    return { role: 'compactionSummary', summary };
}
//# sourceMappingURL=record-identity.js.map