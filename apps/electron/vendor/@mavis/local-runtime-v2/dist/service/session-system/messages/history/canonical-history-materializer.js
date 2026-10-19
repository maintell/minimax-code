import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalActiveHistoryRevision, selectCanonicalHistorySource, } from '../../sessions/representation/canonical-history-contract.js';
import { normalizeLegacyHistoryForMessages, } from './legacy-history-normalizer.js';
export async function ensureCanonicalHistoryMaterialized(options) {
    if (!options.legacyHistory) {
        if (!(await targetExists(options)))
            await options.files.publishInitial(options.paths.messages, []);
        return;
    }
    const checkpoint = await options.legacyHistory.checkpoints.getCheckpoint(options.sessionId);
    if (checkpoint) {
        if (!(await targetExists(options))) {
            throw new Error(`Canonical history target is missing after migration: ${options.sessionId}`);
        }
        return;
    }
    const target = await options.files.readTarget(options.paths.messages);
    const selected = await selectLegacySource(options);
    const normalized = normalizeSelectedHistory(options.sessionId, selected.records);
    const materialized = target === undefined
        ? await publishInitialTarget(options, normalized.items)
        : await verifyExistingTarget(options, target, normalized.items);
    const verified = await verifyMaterializedTarget(options, materialized.records);
    const revision = canonicalActiveHistoryRevision(verified);
    await writeMaterializationReport(options, {
        source: selected.source,
        inputMessageCount: selected.records.length,
        targetMessageCount: verified.length,
        targetRevision: revision,
        materialization: materialized.materialization,
        normalization: normalized,
    });
    await options.legacyHistory.checkpoints.upsertCheckpoint({
        sessionId: options.sessionId,
        migratedAtMs: options.nowMs(),
        source: selected.source,
        messageCount: verified.length,
        targetRevision: revision,
    });
}
async function targetExists(options) {
    return options.files.targetExists
        ? options.files.targetExists(options.paths.messages)
        : (await options.files.readTarget(options.paths.messages)) !== undefined;
}
async function selectLegacySource(options) {
    const legacy = options.legacyHistory;
    if (!legacy)
        return { source: 'empty', records: [] };
    const selected = await selectCanonicalHistorySource({
        readTarget: async () => undefined,
        readAuthoritativeLedgerSnapshot: () => legacy.sources.readLedgerSnapshot(options.sessionId),
        readSqliteRows: () => legacy.sources.readSqliteRows(options.sessionId),
        readSqliteBlob: () => legacy.sources.readSqliteBlob(options.sessionId),
    });
    if (selected.source === 'target') {
        throw new Error(`Canonical history source selection is invalid: ${options.sessionId}`);
    }
    return { source: selected.source, records: selected.records };
}
function normalizeSelectedHistory(sessionId, records) {
    return normalizeLegacyHistoryForMessages(records, {
        message: (envelope) => envelope.message,
        replaceAssistantContent: (envelope, content) => ({
            ...envelope,
            message: { ...envelope.message, content },
        }),
    }, { tag: sessionId });
}
async function publishInitialTarget(options, candidate) {
    const publication = await options.files.publishInitial(options.paths.messages, candidate);
    if (publication.status === 'published') {
        return { records: publication.records, materialization: 'published' };
    }
    return verifyExistingTarget(options, publication.records, candidate);
}
async function verifyExistingTarget(options, observedTarget, candidate) {
    const target = await options.files.readStrict(options.paths.messages);
    if (canonicalActiveHistoryRevision(observedTarget) !== canonicalActiveHistoryRevision(target)) {
        throw new Error(`Canonical history target changed during materialization: ${options.sessionId}`);
    }
    if (canonicalActiveHistoryRevision(target) !== canonicalActiveHistoryRevision(candidate)) {
        throw new Error(`Canonical history materialization is ambiguous: ${options.sessionId}`);
    }
    return { records: target, materialization: 'matched-target' };
}
async function verifyMaterializedTarget(options, expected) {
    const verified = await options.files.readStrict(options.paths.messages);
    if (canonicalActiveHistoryRevision(verified) !== canonicalActiveHistoryRevision(expected)) {
        throw new Error(`Canonical history materialization verification failed: ${options.sessionId}`);
    }
    return verified;
}
async function writeMaterializationReport(options, report) {
    if (report.source === 'empty' &&
        report.materialization === 'published' &&
        report.normalization.warnings.length === 0) {
        return;
    }
    await mkdir(options.paths.reports, { recursive: true, mode: 0o700 });
    const path = join(options.paths.reports, 'history-materialization.json');
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.write(`${JSON.stringify({
                schemaVersion: 1,
                sessionId: options.sessionId,
                source: report.source,
                migratedAtMs: options.nowMs(),
                inputMessageCount: report.inputMessageCount,
                targetMessageCount: report.targetMessageCount,
                targetRevision: report.targetRevision,
                materialization: report.materialization,
                normalization: {
                    stats: report.normalization.stats,
                    warnings: report.normalization.warnings,
                },
            }, null, 2)}\n`);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, path);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
//# sourceMappingURL=canonical-history-materializer.js.map