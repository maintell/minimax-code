import { isLegacyPiHistoryReady } from './legacy-opencode-migration-records.js';
import { buildSessionStatusWarnings, buildSourceFingerprint, mergeMigrationReport, mergeWarnings, } from './legacy-opencode-migration-values.js';
function displayReadyAtMs(input) {
    const { messageStats, existingRecord, now } = input;
    if (messageStats?.displayReady && !messageStats.retryable)
        return now;
    return existingRecord?.displayReadyAtMs ?? existingRecord?.projectionReadyAtMs;
}
function piHistoryReadyAtMs(input) {
    const { messageStats, existingRecord, now } = input;
    if (messageStats?.piHistoryReady && !messageStats.retryable)
        return now;
    return (existingRecord?.piHistoryReadyAtMs ??
        (isLegacyPiHistoryReady(existingRecord) ? existingRecord?.projectionReadyAtMs : undefined));
}
function migrationStatus(input, piHistoryReady) {
    if (input.messageStats?.piHistoryFailClosed)
        return input.existingRecord?.status ?? 'metadata';
    return piHistoryReady || input.existingRecord?.status === 'migrated' ? 'migrated' : 'metadata';
}
function piHistoryIdentity(input) {
    const { messageStats, existingRecord, now } = input;
    // A failed native upgrade must retain its old watermark and converter identity
    // so continuation rows remain distinguishable and the next call retries.
    if (messageStats?.piHistoryFailClosed) {
        return {
            migratedAtMs: existingRecord?.migratedAtMs ?? now,
            piHistoryStrategy: existingRecord?.piHistoryStrategy,
            piHistoryConverterVersion: existingRecord?.piHistoryConverterVersion,
        };
    }
    return {
        migratedAtMs: now,
        piHistoryStrategy: messageStats?.piHistoryStrategy ?? existingRecord?.piHistoryStrategy,
        piHistoryConverterVersion: messageStats?.piHistoryConverterVersion ?? existingRecord?.piHistoryConverterVersion,
    };
}
function importWatermarks(input, displayReady, piHistoryReady) {
    const ledgerImported = displayReady || piHistoryReady ? input.now : input.existingRecord?.ledgerImportedAtMs;
    const persistedPiHistoryReady = input.messageStats?.piHistoryFailClosed
        ? input.existingRecord?.piHistoryReadyAtMs
        : piHistoryReady;
    return {
        ...(ledgerImported ? { ledgerImportedAtMs: ledgerImported } : {}),
        ...(displayReady ? { projectionReadyAtMs: displayReady, displayReadyAtMs: displayReady } : {}),
        ...(persistedPiHistoryReady ? { piHistoryReadyAtMs: persistedPiHistoryReady } : {}),
    };
}
function importAudit(input) {
    const { existingRecord, messageStats } = input;
    return {
        sourceChecksum: messageStats?.sourceChecksum ?? existingRecord?.sourceChecksum,
        displayChecksum: messageStats?.displayChecksum ?? existingRecord?.displayChecksum,
        sourceMessageCount: messageStats?.sourceMessageCount ?? input.sourceMessageCount,
        importedMessageCount: messageStats?.importedMessageCount ?? existingRecord?.importedMessageCount,
        report: mergeMigrationReport(existingRecord?.report, messageStats?.report, {
            preservePriorDisplay: !input.messagesNeedImport,
            preservePriorPiHistory: !input.piHistoryNeedImport || Boolean(messageStats?.piHistoryFailClosed),
        }),
        warnings: mergeWarnings(existingRecord?.warnings, buildSessionStatusWarnings(input.legacySession), messageStats?.warnings),
    };
}
export function buildImportedMigrationRecord(input) {
    const { legacySession, existingRecord } = input;
    const displayReady = displayReadyAtMs(input);
    const piHistoryReady = piHistoryReadyAtMs(input);
    return {
        legacySessionId: legacySession.sessionId,
        localSessionId: input.localSessionId,
        legacyDaemonSessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: migrationStatus(input, piHistoryReady),
        sourceUpdatedAtMs: legacySession.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(legacySession),
        sourceSchemaFingerprint: input.sourceSchemaFingerprint,
        sourceManifest: input.sourceManifest ?? existingRecord?.sourceManifest,
        ...piHistoryIdentity(input),
        ...importAudit(input),
        ...importWatermarks(input, displayReady, piHistoryReady),
    };
}
export function buildFailedMigrationRecord(input) {
    const { legacySession, existingRecord, err } = input;
    return {
        legacySessionId: legacySession.sessionId,
        localSessionId: legacySession.sessionId,
        legacyDaemonSessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: 'failed',
        migratedAtMs: input.now,
        sourceUpdatedAtMs: legacySession.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(legacySession),
        sourceSchemaFingerprint: input.sourceSchemaFingerprint,
        sourceManifest: input.sourceManifest ?? existingRecord?.sourceManifest,
        sourceMessageCount: input.sourceMessageScan?.sourceCount ?? existingRecord?.sourceMessageCount,
        error: { message: err instanceof Error ? err.message : String(err) },
    };
}
function completedImportAtMs(ready, retryable, now) {
    return ready && !retryable ? now : undefined;
}
export function buildPhantomMigrationRecord(input) {
    const { phantomSessionId, realLegacyRoot, messageStats, now } = input;
    const displayReady = completedImportAtMs(messageStats.displayReady, messageStats.retryable, now);
    const piHistoryReady = completedImportAtMs(messageStats.piHistoryReady, messageStats.retryable, now);
    return {
        legacySessionId: phantomSessionId,
        localSessionId: phantomSessionId,
        legacyDaemonSessionId: realLegacyRoot.sessionId,
        legacyFrameworkSessionId: realLegacyRoot.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: piHistoryReady ? 'migrated' : 'metadata',
        migratedAtMs: now,
        sourceUpdatedAtMs: realLegacyRoot.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(realLegacyRoot),
        sourceSchemaFingerprint: input.sourceSchemaFingerprint,
        sourceChecksum: messageStats.sourceChecksum,
        displayChecksum: messageStats.displayChecksum,
        piHistoryStrategy: messageStats.piHistoryStrategy,
        piHistoryConverterVersion: messageStats.piHistoryConverterVersion,
        sourceManifest: input.sourceManifest,
        sourceMessageCount: messageStats.sourceMessageCount ?? input.sourceMessageScan.sourceCount,
        importedMessageCount: messageStats.importedMessageCount,
        report: messageStats.report,
        warnings: mergeWarnings([`phantom_root_fallback:${realLegacyRoot.sessionId}`], messageStats.warnings),
        ...(displayReady ? { displayReadyAtMs: displayReady, projectionReadyAtMs: displayReady } : {}),
        ...(piHistoryReady ? { piHistoryReadyAtMs: piHistoryReady } : {}),
        ...(displayReady || piHistoryReady ? { ledgerImportedAtMs: now } : {}),
    };
}
//# sourceMappingURL=legacy-opencode-migration-result.js.map