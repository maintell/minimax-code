export const EMPTY_CANONICAL_RECOVERY_HISTORY = {
    historyCount: 0,
    historyReady: false,
};
export function canonicalRecoveryCandidate(input) {
    const { existing, previous, trigger } = input;
    if (!existing || !previous || existing.runtime !== 'pi-agent' || !isDisplayReady(previous)) {
        return undefined;
    }
    if (trigger === 'failed_record' && !isKnownMissingLegacyHistoryFailure(previous)) {
        return undefined;
    }
    return { existing, previous };
}
export function canonicalRecoveryRejection(sessionId, session, record) {
    if (!hasCanonicalRecoveryIdentity(sessionId, record))
        return 'migration_identity_conflict';
    if (session.sessionOrigin !== undefined && session.sessionOrigin !== 'legacy-opencode') {
        return 'session_origin_not_legacy';
    }
    if (hasFalseReadyDisplayRecord(record))
        return 'false_ready_display_repair_required';
    return undefined;
}
export function buildCanonicalRecoveryRecord(input) {
    const { previous, trigger, nowMs, preserved } = input;
    const degraded = preserved?.contextBoundary === true;
    return {
        ...previous,
        status: 'migrated',
        piHistoryStrategy: preserved?.strategy ??
            existingCanonicalHistoryStrategy(previous) ??
            CANONICAL_RECOVERY_VERSION,
        piHistoryConverterVersion: preserved
            ? preserved.converterVersion
            : previous.piHistoryConverterVersion,
        piHistoryReadyAtMs: nowMs,
        warnings: mergeWarnings(previous.warnings, preserved?.warnings, [
            canonicalRecoveryWarning(trigger),
        ]),
        report: canonicalRecoveryReport(previous.report, nowMs, trigger, degraded),
        error: undefined,
    };
}
export function buildLegacyContextBoundary(timestamp) {
    return {
        role: 'user',
        content: [
            {
                type: 'text',
                text: `<system-reminder>\n${LEGACY_CONTEXT_BOUNDARY_SUMMARY}\n</system-reminder>`,
            },
        ],
        timestamp,
        archonCompaction: {
            schemaVersion: 1,
            summary: LEGACY_CONTEXT_BOUNDARY_SUMMARY,
        },
        archonLegacyContextBoundary: {
            schemaVersion: 1,
            reason: 'legacy_history_unavailable',
        },
    };
}
export function legacyContextBoundaryPreservation(history) {
    const first = history[0];
    if (!first ||
        first.role !== 'user' ||
        !isCompactionMarker(first['archonCompaction']) ||
        !isLegacyContextBoundaryMarker(first['archonLegacyContextBoundary'])) {
        return undefined;
    }
    return {
        strategy: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
        warnings: [LEGACY_CONTEXT_BOUNDARY_WARNING],
        contextBoundary: true,
    };
}
export function boundedCanonicalRecoveryHistoryCount(count) {
    return Math.min(Math.max(0, count), CANONICAL_RECOVERY_HISTORY_COUNT_LIMIT);
}
export function hasFalseReadyDisplayRecord(record) {
    return Boolean(record &&
        isDisplayReady(record) &&
        record.sourceMessageCount === 0 &&
        record.importedMessageCount === 0 &&
        displaySourceSessionIdVersion(record.report) < LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION);
}
export function isDisplayReady(record) {
    return Boolean(record?.displayReadyAtMs ?? record?.projectionReadyAtMs);
}
export function createCanonicalRecoveryLoggerAdapter(logger) {
    return (event) => logger.info({ ...event }, '[local-runtime-v2] legacy Session canonical recovery');
}
function isKnownMissingLegacyHistoryFailure(record) {
    if (record.status !== 'failed' || !isRecord(record.error))
        return false;
    const message = record.error['message'];
    return (message === 'legacy source not found' ||
        message === 'native OpenCode history is unavailable for a stale native migration' ||
        message === LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR);
}
function hasCanonicalRecoveryIdentity(sessionId, record) {
    return record.sourceRuntime === 'opencode' && record.localSessionId === sessionId;
}
function existingCanonicalHistoryStrategy(record) {
    return typeof record.piHistoryStrategy === 'string' && record.piHistoryStrategy.length > 0
        ? record.piHistoryStrategy
        : undefined;
}
function canonicalRecoveryWarning(trigger) {
    return `legacy_canonical_recovery:${CANONICAL_RECOVERY_VERSION}:${trigger}`;
}
function canonicalRecoveryReport(previous, recoveredAtMs, trigger, degraded) {
    return {
        ...(isRecord(previous) ? previous : {}),
        canonicalRecovery: {
            version: CANONICAL_RECOVERY_VERSION,
            recoveredAtMs,
            trigger,
            displayReady: true,
            historyReady: true,
            result: degraded ? 'degraded' : 'recovered',
            ...(degraded ? { contextBoundary: true } : {}),
        },
    };
}
function isLegacyContextBoundaryMarker(value) {
    return (isRecord(value) &&
        value['schemaVersion'] === 1 &&
        value['reason'] === 'legacy_history_unavailable');
}
function isCompactionMarker(value) {
    return isRecord(value) && value['schemaVersion'] === 1 && typeof value['summary'] === 'string';
}
function displaySourceSessionIdVersion(report) {
    if (!isRecord(report) || !isRecord(report['display']))
        return 0;
    const version = report['display']['sourceSessionIdVersion'];
    return typeof version === 'number' ? version : 0;
}
function mergeWarnings(...groups) {
    const warnings = [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))];
    return warnings.length > 0 ? warnings : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const CANONICAL_RECOVERY_VERSION = 'existing-canonical-recovered-v1';
const CANONICAL_RECOVERY_HISTORY_COUNT_LIMIT = 10_000;
const LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION = 1;
export const LEGACY_CONTEXT_BOUNDARY_STRATEGY = 'legacy-context-boundary-v1';
export const LEGACY_CONTEXT_BOUNDARY_WARNING = 'legacy_context_unavailable:new_context_boundary';
export const LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR = 'legacy context boundary finalization incomplete';
const LEGACY_CONTEXT_BOUNDARY_SUMMARY = 'Earlier legacy conversation context could not be safely recovered during migration. ' +
    'Continue from the next user message as a new context boundary and do not assume details from unavailable history.';
//# sourceMappingURL=canonical-recovery.js.map