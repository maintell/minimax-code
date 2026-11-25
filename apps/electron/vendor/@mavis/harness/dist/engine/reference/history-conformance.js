import { createHarnessHistory } from '../history.js';
import { expectRejects, expectSame, expectTrue } from './conformance-case.js';
const TURN_ID = 'conformance-turn';
const DISPLAY_USER_ID = 'msg-user-v1-conformance-1';
const EXTERNAL_USER_ID = 'msg-user-v1-conformance-2';
const ZERO_USAGE = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});
export function user(text) {
    return { role: 'user', content: text, timestamp: 1 };
}
export function assistant(text, stopReason) {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'conformance',
        provider: 'conformance',
        model: 'conformance',
        usage: ZERO_USAGE,
        stopReason,
        timestamp: 2,
    };
}
/** Unique per write without module state; a case never reads the id back. */
function operationId() {
    return `conformance-operation-${crypto.randomUUID()}`;
}
function append(subject, sessionId, messages, identityHints) {
    return subject.store.append({
        sessionId,
        turnId: TURN_ID,
        reason: 'messageDelta',
        messages,
        operation: { id: operationId(), kind: 'append' },
        ...(identityHints ? { identityHints } : {}),
    });
}
function replacement(sessionId, replacementEntries, messages = (replacementEntries ?? []).map((entry) => entry.message)) {
    return {
        sessionId,
        turnId: TURN_ID,
        reason: 'replaceMessages',
        messages,
        operation: { id: operationId(), kind: 'replace' },
        ...(replacementEntries ? { replacementEntries } : {}),
    };
}
function preserve(message, messageId) {
    return { message, identity: { kind: 'preserve', messageId } };
}
export function identities(snapshot) {
    return snapshot.identityVector ?? [];
}
export async function expectUnchanged(subject, sessionId, before, what) {
    const after = await subject.store.read(sessionId);
    expectSame(after.revision, before.revision, `${what}: revision`);
    expectSame(after.messages, before.messages, `${what}: messages`);
    expectSame(identities(after), identities(before), `${what}: identities`);
}
const readCases = [
    {
        name: 'reads an empty Session as no messages under a revision',
        run: async (subject) => {
            const snapshot = await subject.store.read(await subject.createSession());
            expectSame(snapshot.messages, [], 'messages');
            expectSame(identities(snapshot), [], 'identities');
            expectTrue(snapshot.revision.trim().length > 0, 'the revision is a non-empty string');
        },
    },
    {
        name: 'append answers the full committed history under a new revision',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const empty = await subject.store.read(sessionId);
            const first = await append(subject, sessionId, [user('a')]);
            const second = await append(subject, sessionId, [assistant('b', 'stop')]);
            expectSame(second.messages, [user('a'), assistant('b', 'stop')], 'committed messages');
            expectTrue(first.revision !== empty.revision, 'the first append moves the revision');
            expectTrue(second.revision !== first.revision, 'the second append moves the revision');
        },
    },
    {
        name: 'read answers the latest committed revision and never moves it',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const committed = await append(subject, sessionId, [user('a')]);
            const first = await subject.store.read(sessionId);
            const second = await subject.store.read(sessionId);
            expectSame(first.revision, committed.revision, 'read after the commit');
            expectSame(second.revision, committed.revision, 'repeated read');
            expectSame(identities(first), committed.identityVector ?? [], 'identities');
        },
    },
    {
        name: 'names every committed message with one distinct identity',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await append(subject, sessionId, [user('a'), assistant('b', 'toolUse')]);
            const committed = await append(subject, sessionId, [user('c')]);
            const vector = identities(committed);
            expectSame(vector.length, committed.messages.length, 'one identity per message');
            expectTrue(vector.every((messageId) => messageId.trim().length > 0), 'identities are non-empty');
            expectSame(new Set(vector).size, vector.length, 'distinct identities');
        },
    },
    {
        name: 'keeps Sessions apart',
        run: async (subject) => {
            const written = await subject.createSession();
            const untouched = await subject.createSession();
            await append(subject, written, [user('a')]);
            expectSame((await subject.store.read(untouched)).messages, [], 'the other Session');
        },
    },
];
const identityCases = [
    {
        name: 'append keeps a display-user identity hint',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const committed = await append(subject, sessionId, [user('a'), assistant('b', 'stop')], [{ index: 0, messageId: DISPLAY_USER_ID, source: 'display-user' }]);
            expectSame(identities(committed)[0], DISPLAY_USER_ID, 'hinted identity');
        },
    },
    {
        name: 'replace keeps preserved identities and names new messages afresh',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const before = identities(await append(subject, sessionId, [user('a'), assistant('b', 'stop')]));
            const kept = before[0] ?? '';
            const committed = await subject.store.replace(replacement(sessionId, [
                preserve(user('a'), kept),
                { message: assistant('c', 'stop'), identity: { kind: 'new', seed: 'c' } },
            ]));
            const after = identities(committed);
            expectSame(committed.messages, [user('a'), assistant('c', 'stop')], 'replaced messages');
            expectSame(after[0], kept, 'preserved identity');
            expectTrue(!before.includes(after[1] ?? kept), 'a new message gets a new identity');
        },
    },
    {
        name: 'replace keeps an external user identity',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const [kept = ''] = identities(await append(subject, sessionId, [user('a')]));
            const committed = await subject.store.replace(replacement(sessionId, [
                preserve(user('a'), kept),
                { message: user('b'), identity: { kind: 'external-user', messageId: EXTERNAL_USER_ID } },
            ]));
            expectSame(identities(committed), [kept, EXTERNAL_USER_ID], 'replaced identities');
        },
    },
];
const failClosedCases = [
    {
        name: 'replace without an identity plan fails closed',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await append(subject, sessionId, [user('a')]);
            const before = await subject.store.read(sessionId);
            await expectRejects(() => subject.store.replace(replacement(sessionId, undefined, [user('b')])), 'replace without replacement entries');
            await expectUnchanged(subject, sessionId, before, 'history after the refused replace');
        },
    },
    {
        name: 'replace preserving an unknown identity fails closed',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await append(subject, sessionId, [user('a')]);
            const before = await subject.store.read(sessionId);
            await expectRejects(() => subject.store.replace(replacement(sessionId, [preserve(user('a'), 'msg-unknown')])), 'replace preserving an unknown identity');
            await expectUnchanged(subject, sessionId, before, 'history after the refused replace');
        },
    },
];
const continuationCases = [
    {
        name: 'continuation inspect reads the committed history without writing',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await append(subject, sessionId, [user('a')]);
            const committed = await subject.store.read(sessionId);
            const inspected = await subject.continuation.inspect(sessionId);
            expectSame(inspected.revision, committed.revision, 'inspected revision');
            expectSame(inspected.messages, committed.messages, 'inspected messages');
            await expectUnchanged(subject, sessionId, committed, 'history after the inspection');
        },
    },
    {
        name: 'inspectContinuation derives the state from the Host history',
        run: async (subject) => {
            const history = createHarnessHistory();
            const sessionId = await subject.createSession();
            const inspect = () => history.inspectContinuation({ sessionId, history: subject.continuation });
            expectSame((await inspect()).state, 'unavailable', 'empty history');
            await append(subject, sessionId, [user('a')]);
            const pending = await inspect();
            expectSame(pending.state, 'available', 'user tail');
            expectSame(pending.historyRevision, (await subject.store.read(sessionId)).revision, 'revision');
            await append(subject, sessionId, [assistant('b', 'stop')]);
            expectSame((await inspect()).state, 'unavailable', 'answered tail');
        },
    },
];
/** Answers every Host canonical history must give the harness, derived from the desktop store. */
export const canonicalHistoryConformanceCases = Object.freeze([
    ...readCases,
    ...identityCases,
    ...failClosedCases,
    ...continuationCases,
]);
//# sourceMappingURL=history-conformance.js.map