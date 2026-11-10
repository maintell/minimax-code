import { checksumJson } from './legacy-opencode-display-transforms.js';
import { PI_SEED_MARKER_PREFIX } from './legacy-opencode-pi-seed.js';
import { logger } from '../logging/logger.js';
const AUTO_LEGACY_AGENT_DESCRIPTIONS = new Set([
    'Migrated legacy opencode agent',
    'Legacy opencode sessions pending local Pi migration',
]);
const LEGACY_MIGRATION_LOG_PREFIX = '[legacy-opencode-migration]';
export function formatWarningError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.replace(/\s+/g, '_').slice(0, 160);
}
export function logLegacyMigrationInfo(message) {
    logger.info({ prefix: LEGACY_MIGRATION_LOG_PREFIX, message }, 'Legacy opencode migration info');
}
export function logLegacyMigrationWarn(message) {
    logger.warn({ prefix: LEGACY_MIGRATION_LOG_PREFIX, message }, 'Legacy opencode migration warning');
}
export function formatLogValue(value) {
    return String(value).replace(/\s+/g, '_').slice(0, 200);
}
export function readReportNumber(report, key) {
    const value = report[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
export function describeNativeFallbackReason(native) {
    if (!native)
        return 'native-missing';
    if (native.report && typeof native.report === 'object') {
        const report = native.report;
        if (typeof report.qualityGateFailure === 'string') {
            return `native-quality-gate:${report.qualityGateFailure}`;
        }
        if ('error' in report) {
            return `native-error:${formatLogValue(report.error)}`;
        }
    }
    return 'native-empty';
}
export function hasPiSeedMarker(messages, sessionId) {
    const marker = `${PI_SEED_MARKER_PREFIX}${sessionId}`;
    return messages.some((message) => JSON.stringify(message).includes(marker));
}
export function normalizeMigratedStatus(status, rawStatus) {
    return isUnsafeResumableLegacyStatus(rawStatus ?? status) ? 'interrupted' : status;
}
export function buildSourceFingerprint(session) {
    return checksumJson({
        sessionId: session.sessionId,
        legacyFrameworkSessionId: session.legacyFrameworkSessionId,
        updatedAtMs: session.updatedAtMs,
        status: session.status,
        legacyRawStatus: session.legacyRawStatus,
    });
}
export function isUnsafeResumableLegacyStatus(status) {
    const normalized = status?.trim().toLowerCase();
    return (normalized === 'started' ||
        normalized === 'running' ||
        normalized === 'pending' ||
        normalized === 'partial' ||
        normalized === 'in_progress' ||
        normalized === 'queued' ||
        normalized === 'processing' ||
        normalized === 'streaming' ||
        normalized === 'active');
}
export function buildSessionStatusWarnings(session) {
    return isUnsafeResumableLegacyStatus(session.legacyRawStatus)
        ? [`legacy_session_status_preserved_as_interrupted:${session.legacyRawStatus}`]
        : [];
}
export function buildMessageScanWarnings(scan) {
    return [
        ...(scan.parseErrorCount > 0 ? [`legacy_message_parse_loss:${scan.parseErrorCount}`] : []),
        ...(scan.duplicateMsgIdCount > 0
            ? [`legacy_source_duplicate_msg_id:${scan.duplicateMsgIdCount}`]
            : []),
        ...(scan.missingMsgIdCount > 0
            ? [`legacy_source_missing_msg_id:${scan.missingMsgIdCount}`]
            : []),
    ];
}
export function readSourceSchemaFingerprint(manifest) {
    return manifest.legacyDaemonSchema?.fingerprint;
}
export function backfillAutoDisplayName(existingDisplayName, legacyDisplayName, agentName) {
    if (legacyDisplayName && (!existingDisplayName || existingDisplayName === agentName)) {
        return legacyDisplayName;
    }
    return existingDisplayName || legacyDisplayName || agentName;
}
export function backfillAutoDescription(existingDescription, legacyDescription) {
    if (legacyDescription &&
        (!existingDescription || AUTO_LEGACY_AGENT_DESCRIPTIONS.has(existingDescription))) {
        return legacyDescription;
    }
    return existingDescription;
}
export function backfillAutoDefaultWorkspaceDir(existingWorkspaceDir, legacyWorkspaceDir, sessionWorkspaceDir, defaultWorkspaceDir) {
    const generatedWorkspaceDir = !existingWorkspaceDir ||
        existingWorkspaceDir === sessionWorkspaceDir ||
        existingWorkspaceDir === defaultWorkspaceDir;
    if (legacyWorkspaceDir && generatedWorkspaceDir)
        return legacyWorkspaceDir;
    return existingWorkspaceDir || legacyWorkspaceDir || sessionWorkspaceDir || defaultWorkspaceDir;
}
export function mergeWarnings(existing, ...nextGroups) {
    const merged = [...(existing ?? []), ...nextGroups.flatMap((group) => group ?? [])].filter(Boolean);
    return merged.length > 0 ? [...new Set(merged)] : undefined;
}
/**
 * Merge the prior migration report with the report produced by the latest
 * `migrateMessages` round. Each round only re-computes the section(s) it just
 * imported (display / pi-history), so without merging the persisted `report`
 * would alternate between display-only and pi-history-only snapshots and lose
 * cumulative state. Pass `preservePriorDisplay` when this round skipped
 * display import and `preservePriorPiHistory` when this round skipped
 * pi-history import; the corresponding section is then copied from the prior
 * report so the persisted view reflects everything imported so far.
 */
export function mergeMigrationReport(prior, next, options) {
    if (!isPlainObject(next))
        return next ?? prior;
    if (!isPlainObject(prior))
        return next;
    const merged = { ...next };
    if (options.preservePriorDisplay && prior.display !== undefined) {
        merged.display = prior.display;
    }
    if (options.preservePriorPiHistory && prior.piHistory !== undefined) {
        merged.piHistory = prior.piHistory;
    }
    return merged;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=legacy-opencode-migration-values.js.map