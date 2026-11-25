import { historyArchive } from '../history/canonical/archive-plan.js';
import { canonicalHistoryMessage } from '../history/canonical/record-identity.js';
import { createSinkCanonicalHistory } from '../history/canonical/sink-history.js';
import { createHarnessHistory } from '../history.js';
import { HarnessConformanceError, expectRejects, expectSame, expectTrue, } from './conformance-case.js';
import { assistant, expectUnchanged, identities, user } from './history-conformance.js';
const TURN_ID = 'lineage-turn';
const RETRACTED_TURN_ID = 'lineage-retracted-turn';
function userId(index) {
    return `msg-user-v1-lineage-${String(index)}`;
}
function ids(records) {
    return records.map(({ message_id }) => message_id);
}
function record(messageId, message) {
    return { message_id: messageId, turn_id: TURN_ID, message: canonicalHistoryMessage(message) };
}
/** Appends one settled exchange whose user message is `userId(index)`; answers both identities. */
async function appendExchange(subject, sessionId, index, turnId = TURN_ID) {
    const committed = await subject.store.append({
        sessionId,
        turnId,
        reason: 'messageDelta',
        messages: [user(`u${String(index)}`), assistant(`a${String(index)}`, 'stop')],
        operation: { id: `lineage-append-${crypto.randomUUID()}`, kind: 'append' },
        identityHints: [{ index: 0, messageId: userId(index), source: 'display-user' }],
    });
    return identities(committed).slice(-2);
}
function compactionMetadata(compactionId, messagesBefore, messagesAfter) {
    const metadata = {
        replacementId: compactionId,
        strategyVersion: 'conformance-v1',
        summary: `Summary before ${compactionId}`,
        compactedMessages: [],
        keptMessages: [],
        firstKeptIndex: 0,
        compactionAttemptId: `lineage-attempt-${compactionId}`,
        compactionMethod: 'llm_checkpoint',
        compactionPhase: 'manual',
        messagesBefore,
        messagesAfter,
        tokensBefore: 0,
        tokensAfter: 0,
        serializedBytesBefore: 0,
        serializedBytesAfter: 0,
    };
    return metadata;
}
/** A checkpoint compaction: one summary leads the replacement. Equal inputs give an equal change. */
function checkpoint(sessionId, compactionId, messagesBefore, turnId) {
    return {
        sessionId,
        turnId,
        reason: 'replaceMessages',
        messages: [{ role: 'compactionSummary', summary: `Summary before ${compactionId}` }],
        operation: { id: `lineage-compaction-${compactionId}`, kind: 'compaction' },
        metadata: compactionMetadata(compactionId, messagesBefore, 1),
    };
}
function commitCompaction(subject, change) {
    if (!subject.store.compact)
        throw new HarnessConformanceError('typed compaction is unavailable');
    return subject.store.compact(change);
}
async function compact(subject, sessionId, compactionId, turnId = TURN_ID) {
    const before = await subject.store.read(sessionId);
    await commitCompaction(subject, checkpoint(sessionId, compactionId, before.messages.length, turnId));
}
function requireSink(subject) {
    if (!subject.sink)
        throw new HarnessConformanceError('the sink is unavailable');
    return subject.sink;
}
/** The sink as a writer that read `stale` just before another writer moved the head. */
function staleOnce(sink, stale) {
    let served = false;
    return {
        codec: sink.codec,
        readActive: async (sessionId) => {
            if (served)
                return sink.readActive(sessionId);
            served = true;
            return stale;
        },
        listArchives: (sessionId) => sink.listArchives(sessionId),
        readArchive: (sessionId, entry) => sink.readArchive(sessionId, entry),
        append: (sessionId, input) => sink.append(sessionId, input),
        commit: (sessionId, input) => sink.commit(sessionId, input),
        saveRewindStage: (sessionId, stage) => sink.saveRewindStage(sessionId, stage),
        loadRewindStage: (sessionId, operationId) => sink.loadRewindStage(sessionId, operationId),
    };
}
async function retract(subject, mutation) {
    if (!subject.store.retractTurn) {
        throw new HarnessConformanceError('Turn retraction is unavailable');
    }
    return subject.store.retractTurn(mutation);
}
/** Generation 1 with exchange 0 archived and exchange 1 after the summary. */
async function compactedSession(subject) {
    const sessionId = await subject.createSession();
    const first = await appendExchange(subject, sessionId, 0);
    await compact(subject, sessionId, 'c1');
    const second = await appendExchange(subject, sessionId, 1);
    const [summary = ''] = identities(await subject.store.read(sessionId));
    return { sessionId, first, summary, second };
}
async function chainOf(subject, sessionId) {
    const source = await subject.mutations.read(sessionId);
    return {
        generation: source.activeGeneration,
        snapshots: [...source.snapshots]
            .sort((left, right) => left.generation - right.generation)
            .map(({ generation, records }) => ({ generation, ids: ids(records) })),
    };
}
async function activeIds(subject, sessionId) {
    return identities(await subject.store.read(sessionId));
}
function rewind(subject, sessionId, fromUserMessageIdInclusive, options = {}) {
    return createHarnessHistory().rewind({
        sessionId,
        operationId: options.operationId ?? `lineage-rewind-${crypto.randomUUID()}`,
        fromUserMessageIdInclusive,
        history: subject.mutations,
        ...(options.projections ? { projections: options.projections } : {}),
    });
}
async function fork(subject, sourceSessionId, throughMessageId) {
    const targetSessionId = await subject.createSession();
    const outcome = await createHarnessHistory().fork({
        sourceSessionId,
        targetSessionId,
        operationId: `lineage-fork-${crypto.randomUUID()}`,
        throughMessageId,
        history: subject.mutations,
    });
    return { targetSessionId, outcome };
}
async function expectRejectsWithCode(operation, code, what) {
    let received;
    try {
        await operation();
    }
    catch (error) {
        received = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : error;
        expectSame(received, code, `${what}: error code`);
        return;
    }
    throw new HarnessConformanceError(`${what}: expected a rejection`);
}
const hasCompaction = (subject) => typeof subject.store.compact === 'function';
const hasSinkCompaction = (subject) => subject.sink !== undefined && hasCompaction(subject);
const compactionCases = [
    {
        name: 'compaction archives the active history and advances the generation',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const first = await appendExchange(subject, sessionId, 0);
            const before = await subject.store.read(sessionId);
            await compact(subject, sessionId, 'c1');
            const source = await subject.mutations.read(sessionId);
            expectSame(source.snapshots.map(({ records }) => records.map(({ message }) => message)), [before.messages], 'the archive holds the compacted history');
            const [summary = ''] = ids(source.active);
            expectSame(source.active[0]?.message.role, 'compactionSummary', 'leading summary');
            const second = await appendExchange(subject, sessionId, 1);
            await compact(subject, sessionId, 'c2');
            expectSame(await chainOf(subject, sessionId), {
                generation: 2,
                snapshots: [
                    { generation: 0, ids: first },
                    { generation: 1, ids: [summary, ...second] },
                ],
            }, 'chain after two compactions');
        },
    },
    {
        name: 'an archive written before a failed active switch stays off the chain',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            const before = await subject.store.read(sessionId);
            await subject.failNextActiveSwitch(sessionId);
            await expectRejects(() => compact(subject, sessionId, 'c1'), 'compaction over a failed switch');
            expectTrue((await subject.storedArchives(sessionId)).includes('c1'), 'the archive is written before the active switch');
            await expectUnchanged(subject, sessionId, before, 'history after the failed switch');
            expectSame(await chainOf(subject, sessionId), { generation: 0, snapshots: [] }, 'chain after the failed switch');
        },
    },
    {
        name: 'a retried compaction reuses its archive',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const first = await appendExchange(subject, sessionId, 0);
            await subject.failNextActiveSwitch(sessionId);
            await expectRejects(() => compact(subject, sessionId, 'c1'), 'compaction over a failed switch');
            await compact(subject, sessionId, 'c1');
            expectSame((await subject.storedArchives(sessionId)).filter((id) => id === 'c1').length, 1, 'stored copies of the archive');
            expectSame(await chainOf(subject, sessionId), { generation: 1, snapshots: [{ generation: 0, ids: first }] }, 'chain after the retry');
        },
    },
    {
        name: 'an active history without lineage is generation 0',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const seeded = [
                record(userId(0), user('legacy question')),
                record('msg-lineage-legacy-answer', assistant('legacy answer', 'stop')),
            ];
            await subject.seedActive(sessionId, seeded);
            expectSame(await chainOf(subject, sessionId), { generation: 0, snapshots: [] }, 'chain of the seeded history');
            await compact(subject, sessionId, 'c1');
            expectSame(await chainOf(subject, sessionId), { generation: 1, snapshots: [{ generation: 0, ids: ids(seeded) }] }, 'chain after compacting the seeded history');
        },
    },
    {
        name: 'a replacement backup stays off the chain',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId, first, summary, second } = await compactedSession(subject);
            const current = await subject.store.read(sessionId);
            const vector = identities(current);
            const messages = [...current.messages.slice(0, -1), assistant('a1 revised', 'stop')];
            const metadata = {
                replacementId: 'backup-1',
                strategyVersion: 'conformance-v1',
                summary: '',
                compactedMessages: [],
                keptMessages: [],
                firstKeptIndex: 0,
            };
            await subject.store.replace({
                sessionId,
                turnId: TURN_ID,
                reason: 'replaceMessages',
                messages,
                operation: { id: `lineage-replace-${crypto.randomUUID()}`, kind: 'replace' },
                replacementEntries: messages.map((message, index) => ({
                    message,
                    identity: { kind: 'preserve', messageId: vector[index] ?? '' },
                })),
                metadata,
            });
            expectTrue((await subject.storedArchives(sessionId)).includes('backup-1'), 'the replacement backup is stored');
            expectSame(await chainOf(subject, sessionId), { generation: 1, snapshots: [{ generation: 0, ids: first }] }, 'the chain does not reach the backup');
            expectSame(await activeIds(subject, sessionId), [summary, ...second], 'active identities');
        },
    },
];
const rewindCases = [
    {
        name: 'rewind into an archive restores its generation and the older archives',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId, first, summary } = await compactedSession(subject);
            await compact(subject, sessionId, 'c2');
            await appendExchange(subject, sessionId, 2);
            const operationId = 'lineage-rewind-archive';
            const outcome = await rewind(subject, sessionId, userId(1), { operationId });
            expectSame(outcome.generation, 1, 'rewound generation');
            expectSame(await chainOf(subject, sessionId), { generation: 1, snapshots: [{ generation: 0, ids: first }] }, 'chain after the rewind');
            expectSame(await activeIds(subject, sessionId), [summary], 'active identities');
            const retried = await rewind(subject, sessionId, userId(1), { operationId });
            expectSame(retried.generation, 1, 'repeated operation generation');
            expectSame(retried.historyRevision, outcome.historyRevision, 'repeated operation revision');
            expectSame(await activeIds(subject, sessionId), [summary], 'active after the repetition');
        },
    },
    {
        name: 'compaction after a rewind archives the rewound history',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId, first, summary } = await compactedSession(subject);
            await compact(subject, sessionId, 'c2');
            await rewind(subject, sessionId, userId(1));
            const third = await appendExchange(subject, sessionId, 3);
            await compact(subject, sessionId, 'c3');
            expectSame(await chainOf(subject, sessionId), {
                generation: 2,
                snapshots: [
                    { generation: 0, ids: first },
                    { generation: 1, ids: [summary, ...third] },
                ],
            }, 'chain after compacting the rewound history');
        },
    },
    {
        name: 'rewind publication over a moved head fails closed',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            await appendExchange(subject, sessionId, 1);
            const concurrent = {
                name: 'lineage-concurrent-append',
                rewind: async () => {
                    await appendExchange(subject, sessionId, 2);
                    return { status: 'applied' };
                },
            };
            await expectRejects(() => rewind(subject, sessionId, userId(1), { projections: [concurrent] }), 'rewind published over a moved head');
            const after = await activeIds(subject, sessionId);
            expectSame(after.length, 6, 'messages after the refused rewind');
            expectSame(after[4], userId(2), 'the concurrent append survives');
        },
    },
    {
        name: 'a missing mutation target fails as not found',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId } = await compactedSession(subject);
            const before = await subject.store.read(sessionId);
            await expectRejectsWithCode(() => rewind(subject, sessionId, userId(99)), 'boundary-not-found', 'rewind to a missing user message');
            await expectRejectsWithCode(() => fork(subject, sessionId, 'msg-lineage-missing'), 'boundary-not-found', 'fork through a missing message');
            await expectUnchanged(subject, sessionId, before, 'history after the refused mutations');
        },
    },
];
const forkCases = [
    {
        name: 'fork through an archived message copies that generation',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId, first } = await compactedSession(subject);
            const { targetSessionId, outcome } = await fork(subject, sessionId, first[1] ?? '');
            expectSame(outcome.generation, 0, 'forked generation');
            expectSame(await chainOf(subject, targetSessionId), { generation: 0, snapshots: [] }, 'target chain');
            expectSame(await activeIds(subject, targetSessionId), first, 'target active identities');
        },
    },
    {
        name: 'fork through the active history carries the archives with the target',
        appliesTo: hasCompaction,
        run: async (subject) => {
            const { sessionId, first, summary, second } = await compactedSession(subject);
            const sourceBefore = await subject.store.read(sessionId);
            const { targetSessionId, outcome } = await fork(subject, sessionId, second[1] ?? '');
            expectSame(outcome.generation, 1, 'forked generation');
            expectSame(await chainOf(subject, targetSessionId), { generation: 1, snapshots: [{ generation: 0, ids: first }] }, 'target chain');
            expectSame(await activeIds(subject, targetSessionId), [summary, ...second], 'target active identities');
            const rewound = await rewind(subject, targetSessionId, userId(0));
            expectSame(rewound.generation, 0, 'target rewound into its own archive');
            expectSame(await activeIds(subject, targetSessionId), [], 'target active after the rewind');
            await expectUnchanged(subject, sessionId, sourceBefore, 'source history');
            expectSame((await chainOf(subject, sessionId)).generation, 1, 'source generation');
        },
    },
];
const retractCases = [
    {
        name: 'retracting a Turn across a compaction restores the generation before it',
        appliesTo: (subject) => hasCompaction(subject) && typeof subject.store.retractTurn === 'function',
        run: async (subject) => {
            const sessionId = await subject.createSession();
            const kept = await appendExchange(subject, sessionId, 0);
            const retracted = await appendExchange(subject, sessionId, 1, RETRACTED_TURN_ID);
            await compact(subject, sessionId, 'c1', RETRACTED_TURN_ID);
            const [summary = ''] = await activeIds(subject, sessionId);
            const mutation = {
                kind: 'retract-turn',
                sessionId,
                turnId: RETRACTED_TURN_ID,
                reason: { kind: 'fatal' },
                operation: { id: 'lineage-retract', kind: 'turn-retraction' },
            };
            const committed = await retract(subject, mutation);
            expectSame(committed.status, 'committed', 'retraction status');
            expectSame(identities(committed), kept, 'history after the retraction');
            expectSame([...committed.deletedMessageIds].sort(), [...retracted, summary].sort(), 'deleted identities');
            expectSame(await chainOf(subject, sessionId), { generation: 0, snapshots: [] }, 'chain after the retraction');
            const retried = await retract(subject, mutation);
            expectSame(retried.status, 'already-retracted', 'repeated retraction status');
            expectSame(identities(retried), kept, 'history after the repetition');
        },
    },
];
const sinkCases = [
    {
        name: 'sink append and commit under a stale revision write nothing',
        appliesTo: (subject) => subject.sink !== undefined,
        run: async (subject) => {
            const sink = requireSink(subject);
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            const stale = await sink.readActive(sessionId);
            await appendExchange(subject, sessionId, 1);
            const before = await subject.store.read(sessionId);
            await expectRejectsWithCode(() => sink.append(sessionId, {
                expectedRevision: stale.revision,
                records: [record('msg-lineage-stale', user('stale'))],
            }), 'revision-conflict', 'append under a stale revision');
            await expectRejectsWithCode(() => sink.commit(sessionId, {
                expectedRevision: stale.revision,
                active: stale.records,
                archives: [],
            }), 'revision-conflict', 'commit under a stale revision');
            await expectUnchanged(subject, sessionId, before, 'history after the stale writes');
        },
    },
    {
        name: 'a sink archive key holds one record list',
        appliesTo: hasSinkCompaction,
        run: async (subject) => {
            const sink = requireSink(subject);
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            await compact(subject, sessionId, 'c1');
            const head = await sink.readActive(sessionId);
            const before = await subject.store.read(sessionId);
            const conflicting = historyArchive({
                generation: 0,
                compactionId: 'c1',
                records: [record(userId(7), user('other history'))],
                successor: head.records,
            });
            await expectRejects(() => sink.commit(sessionId, {
                expectedRevision: head.revision,
                active: head.records,
                archives: [conflicting],
            }), 'commit of a different archive under a stored key');
            await expectUnchanged(subject, sessionId, before, 'history after the archive conflict');
        },
    },
    {
        name: 'a compaction racing the identical compaction resolves its revision conflict',
        appliesTo: hasSinkCompaction,
        run: async (subject) => {
            const sink = requireSink(subject);
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            const stale = await sink.readActive(sessionId);
            const change = checkpoint(sessionId, 'c1', stale.records.length, TURN_ID);
            await commitCompaction(subject, change);
            const committed = await subject.store.read(sessionId);
            const chain = await chainOf(subject, sessionId);
            await createSinkCanonicalHistory({ sink: staleOnce(sink, stale) }).provider.compact(change);
            await expectUnchanged(subject, sessionId, committed, 'history after the resolved conflict');
            expectSame(await chainOf(subject, sessionId), chain, 'chain after the resolved conflict');
        },
    },
    {
        name: 'a compaction planned on a moved head surfaces its revision conflict',
        appliesTo: hasSinkCompaction,
        run: async (subject) => {
            const sink = requireSink(subject);
            const sessionId = await subject.createSession();
            await appendExchange(subject, sessionId, 0);
            const stale = await sink.readActive(sessionId);
            const change = checkpoint(sessionId, 'c1', stale.records.length, TURN_ID);
            await appendExchange(subject, sessionId, 1);
            const before = await subject.store.read(sessionId);
            await expectRejectsWithCode(() => createSinkCanonicalHistory({ sink: staleOnce(sink, stale) }).provider.compact(change), 'revision-conflict', 'compaction planned on a moved head');
            await expectUnchanged(subject, sessionId, before, 'history after the refused compaction');
        },
    },
];
/**
 * Lineage answers every Host canonical history must give the harness, however
 * its codec encodes the parent pointer.
 */
export const historyLineageConformanceCases = Object.freeze([
    ...compactionCases,
    ...rewindCases,
    ...forkCases,
    ...retractCases,
    ...sinkCases,
]);
//# sourceMappingURL=history-lineage-conformance.js.map