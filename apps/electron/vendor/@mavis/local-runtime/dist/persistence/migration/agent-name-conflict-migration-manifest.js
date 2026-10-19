import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './agent-name-conflict-migration-files.js';
export const AGENT_NAME_CONFLICT_MANIFEST_SCHEMA_VERSION = 1;
export const CANONICAL_AGENT_NAMES = ['explore', 'worker', 'verifier'];
export const EMPTY_AGENT_NAME_CONFLICT_REFERENCE_COUNTS = {
    primaryDatabase: 0,
    runtimeDatabase: 0,
    yamlFiles: 0,
    planFiles: 0,
    legacyUnclassified: 0,
};
export function readAgentNameConflictManifest(filePath) {
    if (!fs.existsSync(filePath))
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const statuses = new Set([
            'prepared',
            'in_progress',
            'completed',
            'failed',
        ]);
        if (parsed.schemaVersion !== AGENT_NAME_CONFLICT_MANIFEST_SCHEMA_VERSION ||
            !Array.isArray(parsed.mappings) ||
            typeof parsed.status !== 'string' ||
            !statuses.has(parsed.status) ||
            typeof parsed.startedAtMs !== 'number' ||
            !Number.isSafeInteger(parsed.startedAtMs) ||
            parsed.startedAtMs < 0 ||
            typeof parsed.updatedAtMs !== 'number' ||
            !Number.isSafeInteger(parsed.updatedAtMs) ||
            parsed.updatedAtMs < 0 ||
            typeof parsed.migrationId !== 'string' ||
            !new RegExp(`^agent-name-conflicts-${parsed.startedAtMs}$`, 'u').test(parsed.migrationId) ||
            typeof parsed.backupDir !== 'string' ||
            !parsed.backupDir ||
            typeof parsed.updatedReferences !== 'number' ||
            !Number.isSafeInteger(parsed.updatedReferences) ||
            parsed.updatedReferences < 0 ||
            !Array.isArray(parsed.errors) ||
            parsed.errors.some((error) => typeof error !== 'string') ||
            !hasValidObservabilityFields(parsed)) {
            throw new Error('invalid_manifest');
        }
        validateMappings(parsed.mappings);
        return {
            ...parsed,
            phase: parsed.phase ?? (parsed.status === 'failed' ? 'failed' : 'completed'),
            sourceKind: parsed.sourceKind ?? 'legacy-agent-sqlite',
            targetKind: parsed.targetKind ?? 'legacy-runtime-references',
            conflictCount: parsed.conflictCount ?? parsed.mappings.length,
            referenceCounts: parsed.referenceCounts ?? {
                ...EMPTY_AGENT_NAME_CONFLICT_REFERENCE_COUNTS,
                legacyUnclassified: parsed.updatedReferences,
            },
            durationMs: parsed.durationMs ?? 0,
        };
    }
    catch (error) {
        throw new Error(`invalid_agent_name_conflict_manifest:${error instanceof Error ? error.message : String(error)}`);
    }
}
export function writeAgentNameConflictManifest(filePath, manifest) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonAtomic(filePath, manifest);
}
function hasValidObservabilityFields(manifest) {
    return !((manifest.phase !== undefined &&
        !['preflight', 'backup', 'rewrite', 'completed', 'failed'].includes(manifest.phase)) ||
        (manifest.sourceKind !== undefined && manifest.sourceKind !== 'legacy-agent-sqlite') ||
        (manifest.targetKind !== undefined && manifest.targetKind !== 'legacy-runtime-references') ||
        (manifest.conflictCount !== undefined &&
            (!Number.isSafeInteger(manifest.conflictCount) || manifest.conflictCount < 0)) ||
        (manifest.durationMs !== undefined &&
            (!Number.isSafeInteger(manifest.durationMs) || manifest.durationMs < 0)) ||
        (manifest.skipCode !== undefined &&
            !['source_missing', 'table_missing', 'no_conflict'].includes(manifest.skipCode)) ||
        (manifest.errorCode !== undefined &&
            manifest.errorCode !== 'agent_name_conflict_migration_failed') ||
        (manifest.failureStep !== undefined && !isFailureStep(manifest.failureStep)) ||
        (manifest.referenceCounts !== undefined && !isReferenceCounts(manifest.referenceCounts)));
}
function isFailureStep(value) {
    return (typeof value === 'string' &&
        [
            'lock',
            'manifest_prepare',
            'backup',
            'primary_rewrite',
            'runtime_rewrite',
            'yaml_rewrite',
            'plan_rewrite',
            'failure_manifest_write',
        ].includes(value));
}
function validateMappings(mappings) {
    const seenFrom = new Set();
    const seenTo = new Set();
    for (const mapping of mappings) {
        const targetPrefix = typeof mapping?.from === 'string' ? `custom-${mapping.from}` : 'custom-invalid';
        if (!mapping ||
            typeof mapping !== 'object' ||
            !CANONICAL_AGENT_NAMES.includes(mapping.from) ||
            (mapping.to !== targetPrefix &&
                !new RegExp(`^${targetPrefix}-[0-9]+$`, 'u').test(mapping.to)) ||
            !['prepared', 'renamed'].includes(mapping.stage) ||
            mapping.to.includes('/') ||
            mapping.to.includes('\\') ||
            seenFrom.has(mapping.from) ||
            seenTo.has(mapping.to)) {
            throw new Error('invalid_manifest_mapping');
        }
        seenFrom.add(mapping.from);
        seenTo.add(mapping.to);
    }
}
function isReferenceCounts(value) {
    if (!value || typeof value !== 'object')
        return false;
    const expectedKeys = [
        'primaryDatabase',
        'runtimeDatabase',
        'yamlFiles',
        'planFiles',
        'legacyUnclassified',
    ];
    const record = value;
    return (Object.keys(record).length === expectedKeys.length &&
        expectedKeys.every((key) => Object.hasOwn(record, key) &&
            typeof record[key] === 'number' &&
            Number.isSafeInteger(record[key]) &&
            record[key] >= 0));
}
/** Clamped elapsed-time helper shared by the conflict-migration manifest writers. */
export function durationSince(startedAtMs, nowMs) {
    return Math.max(0, nowMs - startedAtMs);
}
//# sourceMappingURL=agent-name-conflict-migration-manifest.js.map