import { boundaryNotFound, HistoryMutationError } from '../history-mutation-error.js';
import { semanticHistoryRevision, withoutHistoryArtifact, } from './canonical-record.js';
const EXTERNAL_USER_ID = /^msg-user-v1-.+$/u;
/** A lineage the rules cannot trust. Host readers raise the storage codes. */
export class HistoryLineageError extends Error {
    code;
    constructor(code, cause) {
        super(`Canonical history scan failed: ${code}`, { cause });
        this.code = code;
        this.name = 'HistoryLineageError';
    }
}
const CHAIN_CORRUPTION_CODES = new Set([
    'artifact-revision-mismatch',
    'parent-mismatch',
    'parent-snapshot-missing',
    'invalid-generation-marker',
    'malformed-jsonl',
    'sequence-corruption',
    'unsafe-artifact',
]);
/**
 * The History mutation error a lineage failure surfaces as, keyed by the error
 * `code` so Host readers may raise the storage codes with their own classes.
 * Other errors pass through.
 */
export function historyMutationErrorOf(error) {
    if (error instanceof HistoryMutationError)
        return error;
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    if (code === 'duplicate-external-user-id' || code === 'external-user-lineage-conflict') {
        return new HistoryMutationError('identity-conflict', 'Canonical history contains a duplicate external user identity', { cause: error });
    }
    if (CHAIN_CORRUPTION_CODES.has(code)) {
        return new HistoryMutationError('chain-corrupt', 'Canonical history chain is corrupt', {
            cause: error,
        });
    }
    return error;
}
/**
 * Walks parent pointers from the active history. Each parent must be listed,
 * plain, reached once and match the revision its pointer stores; external user
 * identities must keep their payload from one generation to the next.
 */
export async function resolveHistoryLineage(source) {
    const walk = await walkHistoryLineage(source, (link) => link);
    const chain = walk.links.map((link, generation) => ({ ...link, generation }));
    validateExternalUserLineage([...chain.map(({ records }) => records), source.active].map((records, generation) => ({
        generation,
        users: externalUsers(records),
    })));
    return { activeGeneration: chain.length, chain, orphans: walk.orphans };
}
/**
 * Runs every check of `resolveHistoryLineage` with the same result and errors, but
 * drops each archive once its revision, parent pointer and external user identities
 * are read, so at most one archive is held at a time. For writes that only place
 * or verify archives; Rewind, Fork and exports read the records.
 */
export async function verifyHistoryLineage(source) {
    const walk = await walkHistoryLineage(source, ({ entry, revision, records }) => ({
        entry,
        revision,
        // `readReachableParent` hashed the whole archive, so its identities hash without error.
        users: [...externalUsers(records)],
    }));
    validateExternalUserLineage([
        ...walk.links.map(({ users }, generation) => ({ generation, users })),
        { generation: walk.links.length, users: externalUsers(source.active) },
    ]);
    return {
        activeGeneration: walk.links.length,
        chain: walk.links.map(({ entry, revision }, generation) => ({ entry, generation, revision })),
        orphans: walk.orphans,
    };
}
/** Reachable parents oldest first, each reduced by `keep` before the next one is read. */
async function walkHistoryLineage(source, keep) {
    const entries = await source.listArchives();
    const claimed = source.codec.storedGeneration?.(source.active);
    let pointer = source.codec.parentOf(source.active, claimed, entries);
    const reached = new Set();
    const links = [];
    while (pointer) {
        const link = await readReachableParent(source, entries, pointer, reached);
        links.unshift(keep(link));
        pointer = source.codec.parentOf(link.records, pointer.generation, entries);
    }
    return { links, orphans: entries.filter((entry) => !reached.has(entry)) };
}
async function readReachableParent(source, entries, pointer, reached) {
    const entry = parentEntry(entries, pointer);
    if (entry.regular === false)
        throw new HistoryLineageError('unsafe-artifact');
    if (reached.has(entry))
        throw new HistoryLineageError('invalid-generation-marker');
    reached.add(entry);
    const records = await source.readArchive(entry);
    const revision = semanticHistoryRevision(records);
    if (pointer.revision !== undefined && revision !== pointer.revision) {
        throw new HistoryLineageError('artifact-revision-mismatch');
    }
    return { entry, records, revision };
}
/** The first listed archive a parent pointer names; a missing parent fails closed. */
function parentEntry(entries, pointer) {
    const entry = entries.find((candidate) => pointerNames(pointer, candidate));
    if (!entry)
        throw new HistoryLineageError('parent-snapshot-missing');
    return entry;
}
/** True when `pointer` names `entry`: the same id, and the same generation where both store one. */
export function pointerNames(pointer, entry) {
    return (entry.compactionId === pointer.compactionId &&
        (pointer.generation === undefined ||
            entry.generation === undefined ||
            entry.generation === pointer.generation));
}
/**
 * A user message keeps its `msg-user-v1-` identity across compaction generations.
 * Every occurrence must be a user message, and a repeated occurrence must carry the
 * same payload in the next generation; otherwise the reachable chain is corrupt.
 */
function validateExternalUserLineage(artifacts) {
    const lineage = new Map();
    for (const artifact of artifacts) {
        for (const { messageId, fingerprint } of artifact.users) {
            if (fingerprint === undefined) {
                throw new HistoryLineageError('external-user-lineage-conflict');
            }
            const previous = lineage.get(messageId);
            if (previous &&
                (previous.fingerprint !== fingerprint ||
                    previous.lastGeneration + 1 !== artifact.generation)) {
                throw new HistoryLineageError('external-user-lineage-conflict');
            }
            lineage.set(messageId, { fingerprint, lastGeneration: artifact.generation });
        }
    }
}
/** External user identities of `records` in order, fingerprinted lazily as the check reaches them. */
function* externalUsers(records) {
    for (const record of records) {
        if (!EXTERNAL_USER_ID.test(record.message_id))
            continue;
        yield record.message.role === 'user'
            ? {
                messageId: record.message_id,
                fingerprint: semanticHistoryRevision([withoutHistoryArtifact(record)]),
            }
            : { messageId: record.message_id };
    }
}
/**
 * Locates an anchor for share continuation: the active history first, then the
 * archives oldest first. A duplicate identity in a searched artifact fails closed.
 */
export function locateHistoryMessage(source, messageId) {
    const artifacts = [
        { generation: source.activeGeneration, records: source.active, archived: false },
        ...[...source.snapshots]
            .sort((left, right) => left.generation - right.generation)
            .map(({ generation, records }) => ({ generation, records, archived: true })),
    ];
    for (const artifact of artifacts) {
        const index = uniqueIndex(artifact.records, messageId);
        const record = artifact.records[index];
        if (record) {
            return { generation: artifact.generation, index, record, archived: artifact.archived };
        }
    }
    return boundaryNotFound(messageId);
}
function uniqueIndex(records, messageId) {
    const identities = new Set();
    let found = -1;
    records.forEach((record, index) => {
        if (identities.has(record.message_id)) {
            throw new HistoryMutationError('identity-conflict', `duplicate message id ${record.message_id}`);
        }
        identities.add(record.message_id);
        if (record.message_id === messageId)
            found = index;
    });
    return found;
}
//# sourceMappingURL=history-lineage.js.map