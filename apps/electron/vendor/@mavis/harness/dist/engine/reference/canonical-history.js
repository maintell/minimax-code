import { DurableCanonicalHistoryStore, } from '../../agent-host/index.js';
import { sameJson, semanticHistoryRevision, } from '../history/canonical/canonical-record.js';
import { historyArtifactCodec } from '../history/canonical/generation-marker.js';
import { createSinkCanonicalHistory } from '../history/canonical/sink-history.js';
import { HistoryMutationError } from '../history/history-mutation-error.js';
/**
 * Settled and active reads are the same here: nothing crashes between a tool
 * call and its result in memory, so no tail needs recovery.
 */
export function createInMemoryCanonicalHistory(options = {}) {
    const { rules } = options;
    const sessions = new Map();
    let sequence = 0;
    const nextRevision = () => {
        sequence += 1;
        return `in-memory-revision-${String(sequence)}`;
    };
    const session = (sessionId) => {
        const history = sessions.get(sessionId);
        if (!history)
            throw new Error(`Session not found: ${sessionId}`);
        return history;
    };
    const switchActive = (history, records) => {
        history.active = structuredClone(records);
        history.revision = nextRevision();
    };
    const sink = inMemorySink(session, switchActive);
    const { provider, mutations } = createSinkCanonicalHistory({
        sink,
        ...(rules ? { rules } : {}),
    });
    return {
        store: new DurableCanonicalHistoryStore(provider),
        continuation: { inspect: provider.read },
        mutations,
        sink,
        createSession: (sessionId) => {
            if (sessions.has(sessionId))
                throw new Error(`Session already exists: ${sessionId}`);
            sessions.set(sessionId, {
                revision: nextRevision(),
                active: [],
                failNextSwitch: false,
                archives: new Map(),
                stages: new Map(),
            });
        },
        storedArchives: (sessionId) => [...session(sessionId).archives.values()].map(({ entry }) => entry.compactionId),
        failNextActiveSwitch: (sessionId) => {
            session(sessionId).failNextSwitch = true;
        },
        seedActive: (sessionId, records) => switchActive(session(sessionId), records),
    };
}
function inMemorySink(session, switchActive) {
    return {
        codec: historyArtifactCodec,
        readActive: async (sessionId) => {
            const history = session(sessionId);
            return { revision: history.revision, records: structuredClone(history.active) };
        },
        listArchives: async (sessionId) => [...session(sessionId).archives.values()].map(({ entry }) => entry),
        readArchive: async (sessionId, entry) => {
            const stored = findArchive(session(sessionId), entry);
            if (!stored)
                throw new Error(`Canonical history archive not found: ${entry.compactionId}`);
            return structuredClone(stored.records);
        },
        append: async (sessionId, input) => {
            const history = session(sessionId);
            assertRevision(history, input.expectedRevision);
            switchActive(history, [...history.active, ...input.records]);
        },
        commit: async (sessionId, input) => {
            const history = session(sessionId);
            if (input.detached)
                writeArchive(history, input.detached);
            for (const archive of input.archives)
                writeArchive(history, archive);
            if (history.failNextSwitch) {
                history.failNextSwitch = false;
                throw new Error(`Injected active history switch failure: ${sessionId}`);
            }
            assertRevision(history, input.expectedRevision);
            switchActive(history, input.active);
        },
        deleteArchives: async (sessionId, entries) => {
            const { archives } = session(sessionId);
            for (const [key, stored] of archives) {
                if (entries.some((entry) => sameJson(entry, stored.entry)))
                    archives.delete(key);
            }
        },
        saveRewindStage: async (sessionId, stage) => {
            session(sessionId).stages.set(stage.operationId, structuredClone(stage));
        },
        loadRewindStage: async (sessionId, operationId) => {
            const stage = session(sessionId).stages.get(operationId);
            return stage && structuredClone(stage);
        },
    };
}
/** An archive is immutable: the same key with the same records is a no-op. */
function writeArchive(history, archive) {
    const key = `${String(archive.generation)}:${archive.compactionId}`;
    const existing = history.archives.get(key);
    if (existing) {
        if (semanticHistoryRevision(existing.records) !== semanticHistoryRevision(archive.records)) {
            throw new Error(`Canonical history archive conflict: ${key}`);
        }
        return;
    }
    history.archives.set(key, {
        entry: historyArtifactCodec.archiveEntry(archive),
        records: structuredClone(archive.records),
    });
}
function findArchive(history, entry) {
    return [...history.archives.values()].find((stored) => sameJson(stored.entry, entry));
}
function assertRevision(history, expected) {
    if (history.revision !== expected) {
        throw new HistoryMutationError('revision-conflict', 'Canonical history revision changed before the write');
    }
}
//# sourceMappingURL=canonical-history.js.map