import path from 'node:path';
import { openAgentDb } from '../../agent/db.js';
import { openLocalRuntimeDb } from '../db.js';
import { applyDirectoryAndPrimaryRename, ensureBackup, rewritePrimaryAgentDatabaseReferences, } from './agent-name-conflict-migration-backup.js';
import { rewriteKnownYamlFiles, rewritePlanFiles } from './agent-name-conflict-migration-files.js';
import { collectMappings, inspectCanonicalAgentNameConflict, } from './agent-name-conflict-migration-inspection.js';
import { AGENT_NAME_CONFLICT_MANIFEST_SCHEMA_VERSION, EMPTY_AGENT_NAME_CONFLICT_REFERENCE_COUNTS, readAgentNameConflictManifest, writeAgentNameConflictManifest, durationSince, } from './agent-name-conflict-migration-manifest.js';
import { rewriteRuntimeReferences } from './agent-name-conflict-migration-runtime.js';
import { resolveV2DirectoryContract, resolveV2MigrationBackupDir } from '../layout/v2-paths.js';
import { createV2BuiltinAgentNameConflictRepair, } from './v2-builtin-agent-name-conflict-migration.js';
const MANIFEST_FILE = 'agent-name-conflicts.json';
const EMPTY_REFERENCE_COUNTS = EMPTY_AGENT_NAME_CONFLICT_REFERENCE_COUNTS;
function rethrowMigrationFailure(failureStep, error, migrationId, secondaryError) {
    if (secondaryError === undefined &&
        typeof error === 'object' &&
        error !== null &&
        'failureStep' in error) {
        throw error;
    }
    const primary = error instanceof Error ? error : new Error(String(error), { cause: error });
    const message = `agent_name_conflict_migration_failed:${failureStep}`;
    const migrationError = secondaryError === undefined
        ? new Error(message, { cause: primary })
        : new AggregateError([primary, secondaryError], message, {
            cause: primary,
        });
    migrationError.failureStep = failureStep;
    migrationError.migrationId = migrationId;
    if (secondaryError !== undefined) {
        migrationError.secondaryFailureStep = 'failure_manifest_write';
    }
    throw migrationError;
}
/**
 * Hands the legacy collision scan/apply and the V2 builtin-name repair to a
 * V2 Agent cutover callback, and revokes them once the callback settles.
 *
 * It takes no lock of its own: the runtime runs the cutover while it holds the
 * dataDir startup migration lock, whose recorded holder pid lets the next
 * startup reclaim it at once when the holder dies mid-cutover. A separate lock
 * here is left behind whenever app.exit or a forced kill ends that startup,
 * and then blocks every later startup until it expires.
 */
export async function withAgentNameConflictMigrationScope(dataDir, operation) {
    let active = true;
    const requireActive = () => {
        if (!active)
            throw new Error('Agent storage lock scope is no longer active');
    };
    const applyCollision = (nowMs = () => Date.now()) => {
        requireActive();
        try {
            return ensureAgentNameConflictMigrationLocked(dataDir, nowMs);
        }
        catch (error) {
            return rethrowMigrationFailure('manifest_prepare', error);
        }
    };
    const repairBuiltinAgentNameConflicts = createV2BuiltinAgentNameConflictRepair(dataDir, requireActive);
    try {
        return await operation({
            inspectCollision: () => {
                requireActive();
                try {
                    return inspectAgentNameConflictMigration(dataDir, getAgentNameConflictMigrationState(dataDir));
                }
                catch (error) {
                    rethrowMigrationFailure('manifest_prepare', error);
                }
            },
            applyCollision,
            prepareCollision: applyCollision,
            repairBuiltinAgentNameConflicts,
        });
    }
    finally {
        active = false;
    }
}
function ensureAgentNameConflictMigrationLocked(dataDir, nowMs) {
    const lockedState = getAgentNameConflictMigrationState(dataDir);
    const completedResult = getCompletedMigrationResult(lockedState);
    if (completedResult)
        return completedResult;
    const inspection = inspectAgentNameConflictMigration(dataDir, lockedState);
    if (inspection.status === 'skipped')
        return migrationResultFromInspection(inspection);
    const agentDb = openAgentDb(dataDir);
    const mappings = lockedState.previous?.mappings ?? collectMappings(agentDb, dataDir);
    if (mappings.length === 0) {
        return migrationResultFromInspection({
            ...inspection,
            status: 'skipped',
            conflictCount: 0,
            mappings: [],
            skipCode: 'no_conflict',
        });
    }
    return applyAgentNameConflictMigration(dataDir, { ...lockedState, agentDb, mappings }, nowMs);
}
function getAgentNameConflictMigrationState(dataDir) {
    const paths = resolveV2DirectoryContract(dataDir);
    const manifestPath = path.join(paths.migrationManifests, MANIFEST_FILE);
    const previous = readAgentNameConflictManifest(manifestPath);
    if (previous) {
        const expectedBackupDir = path.join(resolveV2MigrationBackupDir(dataDir, previous.startedAtMs), previous.migrationId);
        if (path.resolve(previous.backupDir) !== path.resolve(expectedBackupDir)) {
            throw new Error('invalid_agent_name_conflict_manifest:invalid_backup_dir');
        }
    }
    return { manifestPath, previous };
}
function inspectAgentNameConflictMigration(dataDir, state) {
    if (state.previous?.status === 'completed') {
        return {
            status: 'completed',
            sourceKind: state.previous.sourceKind,
            targetKind: state.previous.targetKind,
            sourceRowCount: null,
            conflictCount: state.previous.conflictCount,
            mappings: state.previous.mappings,
            referenceCounts: state.previous.referenceCounts,
            migrationId: state.previous.migrationId,
        };
    }
    if (state.previous?.mappings.length) {
        return {
            status: 'conflict',
            sourceKind: state.previous.sourceKind,
            targetKind: state.previous.targetKind,
            sourceRowCount: null,
            conflictCount: state.previous.conflictCount,
            mappings: state.previous.mappings,
            referenceCounts: state.previous.referenceCounts,
            migrationId: state.previous.migrationId,
        };
    }
    const preflight = inspectCanonicalAgentNameConflict(dataDir);
    return {
        status: preflight.hasConflict ? 'conflict' : 'skipped',
        sourceKind: 'legacy-agent-sqlite',
        targetKind: 'legacy-runtime-references',
        sourceRowCount: preflight.sourceRowCount,
        conflictCount: preflight.conflictCount,
        mappings: [],
        referenceCounts: { ...EMPTY_REFERENCE_COUNTS },
        ...(preflight.skipCode ? { skipCode: preflight.skipCode } : {}),
    };
}
function migrationResultFromInspection(inspection) {
    if (inspection.status !== 'skipped')
        throw new Error('invalid_agent_name_conflict_inspection');
    return {
        status: 'skipped',
        mappings: [],
        updatedReferences: 0,
        phase: 'preflight',
        sourceKind: inspection.sourceKind,
        targetKind: inspection.targetKind,
        conflictCount: inspection.conflictCount,
        referenceCounts: { ...EMPTY_REFERENCE_COUNTS },
        durationMs: 0,
        ...(inspection.skipCode ? { skipCode: inspection.skipCode } : {}),
    };
}
function getCompletedMigrationResult(state) {
    if (state.previous?.status === 'completed') {
        return {
            status: 'completed',
            mappings: state.previous.mappings,
            updatedReferences: state.previous.updatedReferences,
            manifestPath: state.manifestPath,
            migrationId: state.previous.migrationId,
            phase: state.previous.phase,
            sourceKind: state.previous.sourceKind,
            targetKind: state.previous.targetKind,
            conflictCount: state.previous.conflictCount,
            referenceCounts: state.previous.referenceCounts,
            durationMs: state.previous.durationMs,
            ...(state.previous.skipCode ? { skipCode: state.previous.skipCode } : {}),
            ...(state.previous.errorCode ? { errorCode: state.previous.errorCode } : {}),
        };
    }
    return undefined;
}
function applyAgentNameConflictMigration(dataDir, state, nowMs) {
    const { manifestPath, previous, agentDb, mappings } = state;
    const startedAtMs = previous?.startedAtMs ?? nowMs();
    const migrationId = previous?.migrationId ?? `agent-name-conflicts-${startedAtMs}`;
    // Never trust a persisted path: it is metadata, not an authority to choose
    // where this process writes. Derive the backup location from the immutable
    // migration timestamp/id on every retry.
    const backupDir = path.join(resolveV2MigrationBackupDir(dataDir, startedAtMs), migrationId);
    const manifest = previous
        ? { ...previous, backupDir }
        : {
            schemaVersion: AGENT_NAME_CONFLICT_MANIFEST_SCHEMA_VERSION,
            migrationId,
            status: 'prepared',
            phase: 'preflight',
            sourceKind: 'legacy-agent-sqlite',
            targetKind: 'legacy-runtime-references',
            conflictCount: mappings.length,
            startedAtMs,
            updatedAtMs: startedAtMs,
            backupDir,
            mappings,
            updatedReferences: 0,
            referenceCounts: { ...EMPTY_REFERENCE_COUNTS },
            durationMs: 0,
            errors: [],
        };
    let failureStep = 'manifest_prepare';
    try {
        failureStep = 'manifest_prepare';
        manifest.phase = 'backup';
        manifest.updatedAtMs = nowMs();
        manifest.durationMs = durationSince(startedAtMs, manifest.updatedAtMs);
        manifest.failureStep = undefined;
        writeAgentNameConflictManifest(manifestPath, manifest);
        failureStep = 'backup';
        ensureBackup(dataDir, agentDb, backupDir, mappings);
        failureStep = 'manifest_prepare';
        manifest.status = 'in_progress';
        manifest.phase = 'rewrite';
        manifest.updatedAtMs = nowMs();
        manifest.durationMs = durationSince(startedAtMs, manifest.updatedAtMs);
        manifest.errors = [];
        writeAgentNameConflictManifest(manifestPath, manifest);
        failureStep = 'primary_rewrite';
        let primaryUpdatedReferences = 0;
        const applyPrimaryChanges = () => {
            for (const mapping of mappings) {
                applyDirectoryAndPrimaryRename(dataDir, agentDb, mapping, nowMs);
            }
            primaryUpdatedReferences = rewritePrimaryAgentDatabaseReferences(agentDb, mappings);
        };
        const applyPrimaryTransaction = agentDb.transaction?.(applyPrimaryChanges);
        if (applyPrimaryTransaction)
            applyPrimaryTransaction();
        else
            applyPrimaryChanges();
        manifest.updatedReferences += primaryUpdatedReferences;
        manifest.referenceCounts = {
            ...manifest.referenceCounts,
            primaryDatabase: manifest.referenceCounts.primaryDatabase + primaryUpdatedReferences,
        };
        manifest.updatedAtMs = nowMs();
        manifest.durationMs = durationSince(startedAtMs, manifest.updatedAtMs);
        failureStep = 'manifest_prepare';
        writeAgentNameConflictManifest(manifestPath, manifest);
        failureStep = 'runtime_rewrite';
        const runtimeDb = openLocalRuntimeDb(dataDir);
        const runtimeDatabase = rewriteRuntimeReferences(dataDir, runtimeDb, mappings, nowMs);
        failureStep = 'yaml_rewrite';
        const yamlFiles = rewriteKnownYamlFiles(dataDir, mappings);
        failureStep = 'plan_rewrite';
        const planFiles = rewritePlanFiles(dataDir, mappings);
        manifest.updatedReferences += runtimeDatabase + yamlFiles + planFiles;
        manifest.referenceCounts = {
            primaryDatabase: manifest.referenceCounts.primaryDatabase,
            runtimeDatabase: manifest.referenceCounts.runtimeDatabase + runtimeDatabase,
            yamlFiles: manifest.referenceCounts.yamlFiles + yamlFiles,
            planFiles: manifest.referenceCounts.planFiles + planFiles,
            legacyUnclassified: manifest.referenceCounts.legacyUnclassified,
        };
        manifest.updatedAtMs = nowMs();
        manifest.status = 'completed';
        manifest.phase = 'completed';
        manifest.failureStep = undefined;
        manifest.durationMs = durationSince(startedAtMs, manifest.updatedAtMs);
        failureStep = 'manifest_prepare';
        writeAgentNameConflictManifest(manifestPath, manifest);
        return {
            status: manifest.status,
            mappings: manifest.mappings,
            updatedReferences: manifest.updatedReferences,
            manifestPath,
            migrationId: manifest.migrationId,
            phase: manifest.phase,
            sourceKind: manifest.sourceKind,
            targetKind: manifest.targetKind,
            conflictCount: manifest.conflictCount,
            referenceCounts: manifest.referenceCounts,
            durationMs: manifest.durationMs,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            manifest.status = 'failed';
            manifest.phase = 'failed';
            manifest.updatedAtMs = nowMs();
            manifest.durationMs = durationSince(startedAtMs, manifest.updatedAtMs);
            manifest.errorCode = 'agent_name_conflict_migration_failed';
            manifest.failureStep = failureStep;
            manifest.errors = [...manifest.errors, message];
            writeAgentNameConflictManifest(manifestPath, manifest);
        }
        catch (recordError) {
            rethrowMigrationFailure(failureStep, error, migrationId, recordError);
        }
        rethrowMigrationFailure(failureStep, error, migrationId);
    }
}
//# sourceMappingURL=agent-name-conflict-migration.js.map