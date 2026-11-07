import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { allowsManagedMinimaxProviderOverride, getRuntimePresetKey, resolveLocalRuntimeAuthContextPath, resolveModelAvailability, resolveProviderAuthMode, } from '@mavis/config';
import { parseSourceQualifiedModelKey, builtinProviderKind, buildModelEntry, listByokRuntimeModels, routeModelEntries, } from '../../service/model-system/index.js';
import { LegacyOpencodeMigrationError } from '../../infra/legacy-db/legacy-opencode-migrator.js';
import { resolveV2DirectoryContract } from '../../infra/legacy-db/v2-paths.js';
import { collectV2SessionArtifactDiagnostics } from '../../infra/legacy-db/v2-session-artifacts.js';
import { sanitizeConfigValue, splitModelId } from '../../infra/transport/host-http.js';
import { getLocalRuntimeSqliteTableRoleLegend } from '../../infra/legacy-db/sqlite-table-roles.js';
import { routeLocalCronApi } from '../../service/cron/index.js';
import { modelCacheStatusFor } from '../../service/model-system/index.js';
export function makeRuntimeOwnerId(kind) {
    const pid = typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 'unknown';
    return `${kind}:${pid}:${Math.random().toString(36).slice(2)}`;
}
export function serializeLegacyMigrationFailure(error) {
    const record = error.record;
    return {
        error: 'legacy_session_migration_failed',
        code: 'legacy_session_migration_failed',
        message: error.message,
        legacySessionId: record.legacySessionId,
        localSessionId: record.localSessionId,
        diagnosticError: record.error ?? { message: formatUnknownError(error.cause) },
        migration: record,
    };
}
export function serializeMigrationMetadata(migration) {
    return {
        migratedFromRuntime: migration.sourceRuntime,
        legacySessionId: migration.legacySessionId,
        legacyDaemonSessionId: migration.legacyDaemonSessionId ?? migration.legacySessionId,
        ...(migration.legacyFrameworkSessionId
            ? { legacyFrameworkSessionId: migration.legacyFrameworkSessionId }
            : {}),
        status: migration.status,
        migratedAtMs: migration.migratedAtMs,
        ...(migration.sourceUpdatedAtMs ? { sourceUpdatedAtMs: migration.sourceUpdatedAtMs } : {}),
        ...(migration.sourceFingerprint ? { sourceFingerprint: migration.sourceFingerprint } : {}),
        ...(migration.sourceSchemaFingerprint
            ? { sourceSchemaFingerprint: migration.sourceSchemaFingerprint }
            : {}),
        ...(migration.sourceChecksum ? { sourceChecksum: migration.sourceChecksum } : {}),
        ...(migration.displayChecksum ? { displayChecksum: migration.displayChecksum } : {}),
        ...(migration.piHistoryStrategy ? { piHistoryStrategy: migration.piHistoryStrategy } : {}),
        ...(migration.displayReadyAtMs ? { displayReadyAtMs: migration.displayReadyAtMs } : {}),
        ...serializeMigrationOutcome(migration),
    };
}
function serializeMigrationOutcome(migration) {
    return {
        ...(migration.piHistoryReadyAtMs ? { piHistoryReadyAtMs: migration.piHistoryReadyAtMs } : {}),
        ...(migration.sourceMessageCount !== undefined
            ? { sourceMessageCount: migration.sourceMessageCount }
            : {}),
        ...(migration.importedMessageCount !== undefined
            ? { importedMessageCount: migration.importedMessageCount }
            : {}),
        ...(migration.warnings?.length ? { warnings: migration.warnings } : {}),
        ...(migration.error !== undefined ? { error: migration.error } : {}),
    };
}
export function buildFailedLegacyMigrationStub(session, err, record = err instanceof LegacyOpencodeMigrationError ? err.record : undefined) {
    const diagnosticError = record?.error ?? { message: formatUnknownError(err) };
    return {
        ...session,
        sessionId: record?.localSessionId ?? session.sessionId,
        parentSessionId: null,
        runtime: 'pi-agent',
        status: 'error',
        errorMessage: `legacy_session_migration_failed: ${formatUnknownError(diagnosticError)}`,
    };
}
/**
 * Present a clean-mode legacy discovery-only stub to the wire as a pi-agent
 * session. In clean local-runtime mode the user-visible model is "no legacy
 * concept" — mutation gates (PATCH / DELETE / archive / pin / queue /
 * POST /message) all accept every migration status, and on-demand
 * migration (`migrateSession(..., { materialize: true })` in
 * `routes/agents.ts`, or the message-send import hooks) materializes a real
 * pi-agent row. The wire representation must reflect that same invariant, otherwise
 * downstream `frameworkType: session.runtime` in `serialization.ts` leaks
 * `'opencode'` to the UI for every discovery-only stub and the sidebar-
 * / composer-side `isReadOnlyLegacySession` guard (which after MR !4076
 * only looks at `frameworkType === 'opencode'`) hides the input box on
 * every legacy session the user has never opened.
 *
 * When `options.primaryAgentName`/`options.legacyPrimaryAgentName` are
 * provided, the helper also folds the legacy `main` alias into the current
 * primary agent name (mirrors the previous in-place rewrite that lived in
 * `listSessionsForTree`) so the same helper covers both concerns and cannot
 * drift out of sync.
 *
 * Sessions already carrying `runtime === 'pi-agent'` (successfully
 * materialized rows, failed stubs from `buildFailedLegacyMigrationStub`)
 * pass through unchanged so the helper is idempotent and safe to call in
 * every clean-mode list path.
 *
 * Rollback mode must NOT call this helper — legacy sessions there are
 * still owned by the legacy daemon and the read-only guard on
 * `session.runtime === 'opencode'` is the intended behavior.
 */
export function presentLegacyStubAsPiAgent(session, options) {
    if (session.runtime !== 'opencode')
        return session;
    const shouldRewriteAgentName = options?.primaryAgentName !== undefined &&
        options?.legacyPrimaryAgentName !== undefined &&
        session.agentName === options.legacyPrimaryAgentName &&
        options.primaryAgentName !== options.legacyPrimaryAgentName;
    return {
        ...session,
        runtime: 'pi-agent',
        ...(shouldRewriteAgentName ? { agentName: options.primaryAgentName } : {}),
    };
}
export function presentLegacyStubsAsPiAgent(sessions, options) {
    return sessions.map((session) => presentLegacyStubAsPiAgent(session, options));
}
export function formatUnknownError(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === 'string')
        return err;
    if (err && typeof err === 'object' && 'message' in err) {
        const message = err.message;
        return typeof message === 'string' ? message : JSON.stringify(err);
    }
    return String(err);
}
async function mapWithConcurrency(inputs, concurrency, mapper) {
    const output = new Array(inputs.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), inputs.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            output[index] = await mapper(inputs[index], index);
        }
    }));
    return output;
}
function countLegacyMigrationStatuses(records) {
    const counts = { discovered: 0, metadata: 0, migrated: 0, failed: 0, deleted: 0 };
    for (const record of records) {
        counts[record.status] += 1;
    }
    return counts;
}
export async function migrateLegacySessionsForList(input) {
    if (!input.legacyMigrator || input.sessions.length === 0)
        return [];
    const migrated = await mapWithConcurrency(input.sessions, 4, async (session) => {
        try {
            // Discovery-only: cheap fingerprint upsert per legacy session. No
            // local pi-agent row / agent row / message import — those are lazily
            // materialized on demand (`migrateSession(..., { materialize: true })`
            // in `routes/agents.ts`) or when the user sends a message
            // (`ensureLegacyPiHistoryMigrated` → includeMessages+includePiHistory).
            await input.legacyMigrator.migrateSession(session.sessionId);
            return undefined;
        }
        catch (err) {
            if (err instanceof LegacyOpencodeMigrationError) {
                input.emitLegacyMigrationTelemetry(session.sessionId, err);
                return buildFailedLegacyMigrationStub(session, err);
            }
            const record = await input.legacyMigrator.getMigrationRecordForLegacySession(session.sessionId);
            return buildFailedLegacyMigrationStub(session, err, record);
        }
    });
    return migrated.filter((session) => Boolean(session));
}
export function emitLocalLegacyMigrationTelemetry(input) {
    input.telemetry?.({
        runtime: 'pi-agent',
        sessionId: input.sessionId,
        phase: 'failure',
        message: `legacy_session_migration_failed:${formatUnknownError(input.error.record.error ?? input.error)}`,
    });
}
export function routeLocalRuntimeCronApi(input) {
    return routeLocalCronApi(input);
}
export async function normalizeCleanLocalSession(input) {
    const record = await input.legacyMigrator?.getMigrationRecordForLocalSession(input.session.sessionId);
    if (record?.status === 'deleted')
        return undefined;
    return input.normalizeStalePiSession(input.session);
}
/** @internal Exported only for focused tests. */
export async function normalizeStalePiSession(input) {
    if (input.session.runtime !== 'pi-agent' ||
        input.session.status !== 'started' ||
        input.activePiTurns.has(input.session.sessionId)) {
        return input.session;
    }
    if (await input.isSessionLockedByOtherOwner(input.session.sessionId))
        return input.session;
    return ((await input.controller.updateSession(input.session.sessionId, {
        status: 'interrupted',
        errorMessage: 'Local runtime restarted before this turn completed.',
    })) ?? {
        ...input.session,
        status: 'interrupted',
        errorMessage: 'Local runtime restarted before this turn completed.',
    });
}
export function buildLocalRuntimeStatus(input) {
    return {
        status: 'ok',
        runtime: 'local-runtime',
        mode: input.runtimeMode,
        ownerKind: input.runtimeOwnerKind,
        capabilities: input.capabilities,
        surfaces: input.surfaces,
        dataDir: input.config.dataDir,
        ...(input.runtimeStartupToken ? { startupToken: input.runtimeStartupToken } : {}),
    };
}
function migrationPersistenceDiagnostics(input) {
    return {
        sqlite: { tableRoleLegend: getLocalRuntimeSqliteTableRoleLegend() },
        ...(input.verbose && input.dataDir
            ? {
                artifacts: redactMigrationDiagnosticValue(collectV2SessionArtifactDiagnostics(input.dataDir, { maxSessions: 50 }), input.dataDir),
            }
            : {}),
    };
}
export async function buildLocalLegacyMigrationCheck(input) {
    const persistence = migrationPersistenceDiagnostics(input);
    if (!input.legacyMigrator) {
        return {
            mode: input.runtimeMode,
            legacyImport: false,
            persistence,
            totals: {
                legacySessions: 0,
                pending: 0,
                metadata: 0,
                migrated: 0,
                failed: 0,
                deleted: 0,
                records: 0,
            },
            failed: [],
        };
    }
    const legacySessions = await input.legacyMigrator.listLegacySessions(input.agentName);
    const records = await input.legacyMigrator.listMigrationRecords();
    const sourceManifest = input.verbose
        ? await input.legacyMigrator.getSourceManifest?.()
        : undefined;
    const legacyIds = new Set(legacySessions.map((session) => session.sessionId));
    const relevantRecords = input.agentName
        ? records.filter((record) => legacyIds.has(record.legacySessionId))
        : records;
    const recordByLegacyId = new Map(relevantRecords.map((record) => [record.legacySessionId, record]));
    const pending = legacySessions.filter((session) => !recordByLegacyId.has(session.sessionId)).length;
    const byStatus = countLegacyMigrationStatuses(relevantRecords);
    const artifactSessionIds = [
        ...legacySessions.map((session) => session.sessionId),
        ...relevantRecords.map((record) => record.localSessionId),
    ];
    return {
        mode: input.runtimeMode,
        legacyImport: true,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        persistence: {
            ...persistence,
            ...(input.verbose && input.dataDir
                ? {
                    artifacts: redactMigrationDiagnosticValue(collectV2SessionArtifactDiagnostics(input.dataDir, {
                        sessionIds: artifactSessionIds,
                        maxSessions: 200,
                    }), input.dataDir),
                }
                : {}),
        },
        totals: {
            legacySessions: legacySessions.length,
            pending,
            metadata: byStatus.metadata,
            migrated: byStatus.migrated,
            failed: byStatus.failed,
            deleted: byStatus.deleted,
            records: relevantRecords.length,
        },
        ...(input.verbose && sourceManifest !== undefined
            ? {
                sourceManifest: redactMigrationDiagnosticValue(sourceManifest, input.dataDir),
            }
            : {}),
        messages: summarizeLegacyMigrationMessages(relevantRecords),
        records: relevantRecords.slice(0, 200).map((record) => ({
            legacySessionId: record.legacySessionId,
            localSessionId: record.localSessionId,
            legacyDaemonSessionId: record.legacyDaemonSessionId ?? record.legacySessionId,
            legacyFrameworkSessionId: record.legacyFrameworkSessionId,
            status: record.status,
            migratedAtMs: record.migratedAtMs,
            sourceUpdatedAtMs: record.sourceUpdatedAtMs,
            sourceFingerprint: record.sourceFingerprint,
            sourceSchemaFingerprint: record.sourceSchemaFingerprint,
            sourceChecksum: record.sourceChecksum,
            displayChecksum: record.displayChecksum,
            piHistoryStrategy: record.piHistoryStrategy,
            sourceMessageCount: record.sourceMessageCount,
            importedMessageCount: record.importedMessageCount,
            ledgerImportedAtMs: record.ledgerImportedAtMs,
            projectionReadyAtMs: record.projectionReadyAtMs,
            displayReadyAtMs: record.displayReadyAtMs,
            piHistoryReadyAtMs: record.piHistoryReadyAtMs,
            warnings: redactMigrationDiagnosticValue(record.warnings, input.dataDir),
            ...(input.verbose && record.report !== undefined
                ? { report: redactMigrationDiagnosticValue(record.report, input.dataDir) }
                : {}),
        })),
        failed: relevantRecords
            .filter((record) => record.status === 'failed')
            .slice(0, 20)
            .map((record) => ({
            legacySessionId: record.legacySessionId,
            localSessionId: record.localSessionId,
            legacyFrameworkSessionId: record.legacyFrameworkSessionId,
            sourceSchemaFingerprint: record.sourceSchemaFingerprint,
            sourceChecksum: record.sourceChecksum,
            displayChecksum: record.displayChecksum,
            piHistoryStrategy: record.piHistoryStrategy,
            migratedAtMs: record.migratedAtMs,
            sourceMessageCount: record.sourceMessageCount,
            importedMessageCount: record.importedMessageCount,
            warnings: redactMigrationDiagnosticValue(record.warnings, input.dataDir),
            error: redactMigrationDiagnosticValue(record.error, input.dataDir),
        })),
    };
}
function redactMigrationDiagnosticValue(value, dataDir) {
    const roots = [];
    if (dataDir)
        roots.push([path.resolve(dataDir), '<dataDir>']);
    roots.push([os.homedir(), '<home>']);
    return redactDiagnosticValue(value, roots);
}
function redactDiagnosticValue(value, roots) {
    if (typeof value === 'string')
        return redactDiagnosticString(value, roots);
    if (Array.isArray(value))
        return value.map((item) => redactDiagnosticValue(item, roots));
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDiagnosticValue(child, roots)]));
}
function redactDiagnosticString(value, roots) {
    let output = value;
    for (const [root, label] of roots) {
        if (!root || root === path.sep)
            continue;
        const normalizedRoot = path
            .resolve(root)
            .replace(new RegExp(`${escapeRegExp(path.sep)}+$`), '');
        if (!normalizedRoot)
            continue;
        output = output.replace(new RegExp(`${escapeRegExp(normalizedRoot)}(?=$|[\\\\/])`, 'g'), label);
    }
    return output;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function summarizeLegacyMigrationMessages(records) {
    return records.reduce((summary, record) => {
        summary.sourceCount += record.sourceMessageCount ?? 0;
        summary.importedCount += record.importedMessageCount ?? 0;
        if (record.sourceMessageCount !== undefined)
            summary.recordedSourceSessions += 1;
        if (record.importedMessageCount !== undefined)
            summary.recordedImportedSessions += 1;
        return summary;
    }, {
        sourceCount: 0,
        importedCount: 0,
        recordedSourceSessions: 0,
        recordedImportedSessions: 0,
    });
}
export function listLocalRuntimeModels(config, selection, options) {
    const defaultModel = config.defaultModel ?? '';
    const [defaultProviderId, defaultModelId] = splitModelId(defaultModel);
    const selectedProviderId = selection?.providerId ?? defaultProviderId;
    const selectedModelId = selection?.modelId ?? defaultModelId;
    const selectionVariant = selection ? selection.variant : config.defaultModelVariant;
    const hasSelectionVariant = selection
        ? selection.variant !== undefined
        : config.defaultModelVariant !== undefined;
    // Listed per source/route rather than flattening the whole provider tree:
    // a model the current route cannot call must not be offered for selection.
    const builtin = Object.entries(config.provider ?? {}).flatMap(([providerId, provider]) => routeModelEntries(config, providerId, provider).map(([modelId, model]) => {
        return buildModelEntry({
            providerId,
            modelId,
            model,
            selected: providerId === selectedProviderId && modelId === selectedModelId,
            selectionVariant,
            hasSelectionVariant,
            providerSource: 'provider',
            providerKind: builtinProviderKind(config, providerId, provider),
            providerName: provider.name ?? providerId,
            status: options?.cache
                ? modelCacheStatusFor(options.cache, providerId, modelId)
                : undefined,
        });
    }));
    const byok = listByokRuntimeModels(config, {
        providerId: selectedProviderId,
        modelId: selectedModelId,
        variant: selectionVariant,
        hasVariant: hasSelectionVariant,
    }, options?.cache, {
        ...(options?.implicitCustomProviderThinking === true
            ? { implicitCustomProviderThinking: true }
            : {}),
    });
    return [...builtin, ...byok].map((model) => ({ ...model }));
}
export function resolveDefaultLocalWorkspaceDir(defaultWorkspaceDir, config) {
    if (defaultWorkspaceDir)
        return defaultWorkspaceDir;
    return `${config.dataDir}/workspace`;
}
export function buildRuntimeDoctorSnapshot(input) {
    const dataDir = input.config.dataDir;
    const configPath = path.join(dataDir, 'config.yaml');
    const authCachePath = resolveLocalRuntimeAuthContextPath(dataDir);
    const v2 = resolveV2DirectoryContract(dataDir);
    const logsDir = v2.logs;
    const runtimeEventsDir = v2.events;
    const [providerId, modelId] = splitModelId(input.config.defaultModel ?? '');
    const warnings = validateRuntimeConfigFile(configPath, input.config);
    const tokenPresent = Boolean(input.authContext?.accessToken?.trim());
    return {
        status: warnings.length === 0 ? 'ok' : 'error',
        runtime: 'local-runtime',
        surface: doctorSurfaceForOwnerKind(input.runtimeOwnerKind),
        runtimeMode: input.runtimeMode,
        runtimeOwner: {
            kind: input.runtimeOwnerKind,
            id: input.runtimeOwnerId,
        },
        runtimeHttp: {
            startupTokenPresent: Boolean(input.runtimeStartupToken),
        },
        paths: {
            dataDir,
            configPath,
            authCachePath,
            configPresent: existsSync(configPath),
            authCachePresent: existsSync(authCachePath),
        },
        selection: {
            defaultModel: input.config.defaultModel ?? null,
            providerId: providerId ?? null,
            modelId: modelId ?? null,
        },
        provider: doctorProvider(input.config, providerId),
        auth: {
            tokenPresent,
            realUserIDPresent: Boolean(input.authContext?.realUserID?.trim()),
            userEmailPresent: Boolean(input.authContext?.userEmail?.trim()),
            userNamePresent: Boolean(input.authContext?.userName?.trim()),
            subUserNamePresent: Boolean(input.authContext?.subUserName?.trim()),
        },
        // Presence booleans / counts only — BYOK trees hold plaintext keys.
        byok: {
            minimaxApiKeyPresent: Boolean(input.config.minimax_api?.apiKey?.trim()),
            customProviderCount: Object.keys(input.config.custom_provider ?? {}).length,
        },
        observability: {
            eventLogEnabled: true,
            runtimeLogDir: logsDir,
            runtimeEventsDir,
        },
        diagnostics: {
            bundleAvailable: true,
            hostProvider: input.hostDiagnosticsAvailable ? input.runtimeOwnerKind : null,
            hostCaptures: {
                upload: Boolean(input.hostDiagnosticsAvailable),
            },
        },
        capabilities: input.capabilities,
        surfaces: input.surfaces,
        warnings,
    };
}
function doctorProvider(config, providerId) {
    const provider = providerId ? config.provider?.[providerId] : undefined;
    const providerOptions = provider?.options;
    const authModeResolution = resolveProviderAuthMode({
        authMode: providerOptions?.authMode,
        baseURL: providerOptions?.baseURL,
        allowManagedBaseURLOverride: providerId === 'minimax' && allowsManagedMinimaxProviderOverride(),
    });
    return {
        id: providerId ?? null,
        baseURL: providerOptions?.baseURL === undefined
            ? null
            : sanitizeConfigValue('baseURL', providerOptions.baseURL),
        authMode: authModeResolution.authMode,
        authModeSource: authModeResolution.source,
        authModeSourceLabel: formatAuthModeSource(authModeResolution.source),
        managedBaseURL: authModeResolution.managedBaseURL,
        apiKeyPresent: Boolean(typeof providerOptions?.apiKey === 'string' && providerOptions.apiKey.trim().length > 0),
    };
}
function configReadWarnings(error) {
    if (!(error instanceof yaml.YAMLException))
        return ['Config file cannot be read.'];
    const line = error.mark?.line;
    const column = error.mark?.column;
    if (typeof line === 'number' && typeof column === 'number') {
        return [`Config file is not valid YAML at line ${line + 1}, column ${column + 1}.`];
    }
    return ['Config file is not valid YAML.'];
}
function validateRuntimeConfigFile(configPath, effectiveConfig) {
    if (!existsSync(configPath))
        return ['Config file does not exist.'];
    let parsed;
    try {
        parsed = yaml.load(readFileSync(configPath, 'utf-8'));
    }
    catch (error) {
        return configReadWarnings(error);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return ['Config root must be a YAML object.'];
    }
    const fileConfig = parsed;
    const defaultModel = fileConfig.defaultModel?.trim();
    const selection = parseSourceQualifiedModelKey(defaultModel);
    if (!defaultModel || !selection) {
        return ['defaultModel must use the "provider/model" format.'];
    }
    const availability = resolveModelAvailability({
        config: fileConfig,
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset: getRuntimePresetKey(),
        source: 'config_default',
    });
    if (!availability.available) {
        if (isManagedModelAvailable(fileConfig, effectiveConfig, selection))
            return [];
        return [`defaultModel "${defaultModel}" is not available; choose a configured provider/model.`];
    }
    return [];
}
function isManagedModelAvailable(fileConfig, effectiveConfig, selection) {
    const effectiveProvider = effectiveConfig?.provider?.[selection.providerId];
    const effectiveAuthMode = resolveProviderAuthMode({
        authMode: effectiveProvider?.options?.authMode,
        baseURL: effectiveProvider?.options?.baseURL,
    }).authMode;
    // Managed runtime deliberately keeps the protected provider on disk untouched.
    // Validate the raw file for syntax, but use the already-resolved managed provider
    // for this route so Doctor agrees with the process that executes turns.
    const rawProviderIsObject = fileConfig.provider === undefined || isRecord(fileConfig.provider);
    if (selection.providerId === 'minimax' &&
        effectiveAuthMode === 'managed-login' &&
        rawProviderIsObject) {
        const effectiveAvailability = resolveModelAvailability({
            config: {
                ...fileConfig,
                ...(effectiveConfig?.minimaxModelSource !== undefined
                    ? { minimaxModelSource: effectiveConfig.minimaxModelSource }
                    : {}),
                provider: {
                    ...(isRecord(fileConfig.provider) ? fileConfig.provider : {}),
                    minimax: effectiveProvider,
                },
            },
            providerId: selection.providerId,
            modelId: selection.modelId,
            preset: getRuntimePresetKey(),
            source: 'config_default',
        });
        return effectiveAvailability.available;
    }
    return false;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function formatAuthModeSource(source) {
    if (source === 'explicit')
        return 'explicit';
    if (source === 'inferred-managed-base-url')
        return 'compatibility inference from managed baseURL';
    return 'default api-key behavior';
}
function doctorSurfaceForOwnerKind(kind) {
    if (kind === 'electron')
        return 'electron';
    if (kind === 'cli')
        return 'cli-standalone';
    return kind;
}
//# sourceMappingURL=host-support.js.map