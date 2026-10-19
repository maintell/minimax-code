import { LocalQuestionnaireService, createLocalRuntimeHost as createLocalRuntimeHostV1, ensureCurrentLocalRuntimeDataMigratedToV2OrThrow, isLocalRuntimeStartupExecutionEnabled, createDeferredLocalAgentRuntimePort, resolveAgentBashEnvPolicy, buildLocalTrajectoryId, } from '@mavis/local-runtime';
import { DeferredRuntimeConversation } from '@mavis/conversation-contract';
import { ownsElectronRuntimeCapabilities } from './application/index.js';
import { logger } from '@mavis/shared/local-runtime-logging';
import { createBackgroundRuntime } from './background-runtime.js';
import { cleanupFailedV1Startup, createV1RuntimeCompatibility, createDeferredAgentRuntimeTelemetry, withAgentStorageLock, } from './compat/v1/runtime.js';
import { createLocalRuntimeV2FrontDoor, createV2AgentRuntimeManagementPort, ownerCapabilitiesForServices, } from './http/app.js';
import { DatabaseClient } from './infra/db/client.js';
import { initializeDatabase } from './infra/db/initialize.js';
import { createCliService } from './local/app.js';
import { createRuntimeAgentComposition, createDeferredLocalSandboxBashOperationsFactory, createRuntimeServices, prepareRuntimeServices, } from './services.js';
const V2_LAYOUT_MIGRATION_RECEIPT_CARRIER = Symbol.for('mavis.local-runtime.v2-layout-migration-receipt');
/** Creates a fully initialized local runtime. The returned compatibility `ready` is resolved. */
export function createLocalRuntimeHostV2(options) {
    return createLocalRuntimeHostV2Internal(options, {});
}
/** @internal Direct-module test seam; intentionally absent from the package facade. */
export function createLocalRuntimeHostV2ForTest(options, overrides = {}) {
    return createLocalRuntimeHostV2Internal(options, overrides);
}
function bindAskUserSuppressionProbe(apiHost, turnSystem) {
    const turnInspection = turnSystem?.inspection;
    if (!turnInspection?.hasPendingUserSteering)
        return;
    const hasPendingUserSteering = turnInspection.hasPendingUserSteering.bind(turnInspection);
    apiHost.hasPendingUserSteeringProbe = (sessionId) => hasPendingUserSteering(sessionId);
}
function bindV2AgentRuntimeManagementPort(agentRuntimePort, ownerRuntime, agentOwner) {
    agentRuntimePort.bindManagement(createV2AgentRuntimeManagementPort({
        application: ownerRuntime.services.agent,
        service: agentOwner.service,
        readSessionAgentRouting: (sessionId) => ownerRuntime.services.sessionSystem.sessions.records.readSessionAgentRouting(sessionId),
        resolveSessionProjectIdentity: (sessionId) => ownerRuntime.services.sessionSystem.projects.service.resolveSessionProjectIdentity(sessionId),
    }));
}
async function createLocalRuntimeHostV2Internal(options, overrides) {
    const compatibility = createV1Compatibility(isV2RuntimeOwner(options));
    let agentOwner;
    let v1;
    let legacyClose;
    let ownerRuntime;
    const agentRuntimePort = createDeferredLocalAgentRuntimePort();
    const sandboxOperationsFactory = createDeferredLocalSandboxBashOperationsFactory(() => options.configGetter?.().sandbox?.enabled ?? false, resolveAgentBashEnvPolicy(options.dataDir));
    const agentTelemetry = createDeferredAgentRuntimeTelemetry();
    let database;
    let preparedServices;
    const startupStartedAtMs = Date.now();
    const stageTimings = {};
    const measureStage = (stage, run) => {
        const stageStartedAtMs = Date.now();
        try {
            return run();
        }
        finally {
            stageTimings[stage] = Math.max(0, Date.now() - stageStartedAtMs);
        }
    };
    const measureStageAsync = async (stage, run) => {
        const stageStartedAtMs = Date.now();
        try {
            return await run();
        }
        finally {
            stageTimings[stage] = Math.max(0, Date.now() - stageStartedAtMs);
        }
    };
    try {
        // 2026-09-03: the startup generation checkpoint (whole-dataDir copy +
        // fingerprint verification for the manual `generation rollback` CLI) was
        // removed from the boot path entirely. Layout migration is additive and
        // schema migration keeps its own SQLite backup, so the extra whole-tree
        // snapshot bought nothing while costing large IO on every cold start
        // (a 17G dataDir starved the 600s bootstrap watchdog six times in a row).
        // The rootless-v2-generation module remains for the CLI, which acquires
        // its own operation fence.
        // Layout migration must complete before the authoritative V2 target is
        // opened.  The services composition below gates all legacy access on the
        // target Agent row count.
        const completedLayoutMigration = measureStage('layout_migration_ms', () => ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(() => options.dataDir, options.nowMs));
        database = measureStage('db_open_ms', () => new DatabaseClient({
            dataDir: options.dataDir,
            ...(overrides.database?.sqlite3ModulePath
                ? { sqlite3ModulePath: overrides.database.sqlite3ModulePath }
                : {}),
        }));
        const resolvedDatabase = database;
        const initialization = await measureStageAsync('db_initialize_ms', () => initializeDatabase({
            database: resolvedDatabase,
            dataDir: options.dataDir,
            onMigration: options.onDatabaseMigration,
        }));
        reportLegacySessionRecovery({
            recoveredLegacySessionCount: initialization.recoveredLegacySessionCount,
            degradedLegacySessionCount: initialization.degradedLegacySessionCount,
        });
        reportProjectMigrationRecovery({
            recoveredProjectPreferenceCount: initialization.recoveredProjectPreferenceCount,
            skippedSessionProjectRepairCount: initialization.skippedSessionProjectRepairCount,
        });
        agentOwner = await measureStageAsync('agent_composition_ms', () => createRuntimeAgentComposition({
            db: resolvedDatabase.db,
            dataDir: options.dataDir,
            ...(options.promptMode
                ? { promptMode: options.promptMode, promptVersion: options.appVersion }
                : {}),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            withAgentStorageLock: (operation) => withAgentStorageLock(options.dataDir, operation),
            reportCutover: reportAgentCutover,
            reportIdentityDetach: reportAgentIdentityDetach,
            reportLegacyCustomMaterialization: reportLegacyCustomAgentMaterialization,
            facts: agentTelemetry.facts,
        }));
        agentRuntimePort.bindResolver(agentOwner.service);
        preparedServices = compatibility
            ? prepareRuntimeServices({
                db: database.db,
                runtimeOwnerKind: options.runtimeOwnerKind,
            })
            : undefined;
        const configuredOptions = configureV1HostOptions(options, compatibility, agentRuntimePort, {
            sandboxOperationsFactory,
            prepared: preparedServices,
        });
        Object.defineProperty(configuredOptions, V2_LAYOUT_MIGRATION_RECEIPT_CARRIER, {
            value: completedLayoutMigration,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        v1 = createLocalRuntimeHostV1(configuredOptions);
        const resolvedV1 = v1;
        agentTelemetry.bind({
            metricsClient: resolvedV1.metricsClient,
            emitBusEvent: (type, payload) => resolvedV1.apiHost.emitBusEvent(type, payload),
        });
        legacyClose = v1.apiHost.close.bind(v1.apiHost);
        await measureStageAsync('v1_host_ready_ms', async () => resolvedV1.ready);
        const legacyHandleRequest = v1.apiHost.handleRequest.bind(v1.apiHost);
        if (compatibility) {
            if (!preparedServices)
                throw new Error('V2 owner services were not prepared');
            const prepared = preparedServices;
            const owner = agentOwner;
            ownerRuntime = await measureStageAsync('owner_runtime_ms', () => initializeOwnerRuntime({
                v1: resolvedV1,
                compatibility,
                agentOwner: owner,
                database: resolvedDatabase,
                sandboxOperationsFactory,
                prepared,
                disabledLegacyScheduleCount: initialization.disabledLegacyScheduleCount,
                options,
                overrides,
            }));
            bindOwnerRuntimeIntegrations({
                ownerRuntime,
                apiHost: resolvedV1.apiHost,
                agentRuntimePort,
                agentOwner: owner,
                pruneBackups: () => initialization.pruneBackups?.(),
            });
        }
        const frontDoor = createFrontDoor({
            v1,
            legacyHandleRequest,
            ownerRuntime,
            overrides,
            computerUseClient: options.computerUseClient,
        });
        const cliService = ownerRuntime ? createCliService(ownerRuntime.services) : undefined;
        compatibility?.bindHandleRequest(frontDoor.handleRequest);
        const close = createSharedClose({
            ownerRuntime,
            closeV1: legacyClose,
            agentOwner,
            agentTelemetry,
            v1,
            database,
        });
        const ownerCompromiseGuard = createRuntimeOwnerCompromiseGuard(ownerRuntime, close);
        ownerCompromiseGuard.assertHealthy();
        v1.apiHost.handleRequest = frontDoor.handleRequest;
        v1.apiHost.close = close;
        // A fresh profile has no primary Agent row until the detached builtin recovery
        // completes. Gate owner channels on that milestone without making either
        // builtin or Channel recovery part of core Runtime readiness.
        const channelStartupStartedAtMs = Date.now();
        const channelStartup = startChannelSubsystemAfterOwnerAgentDefinitions(ownerRuntime, resolvedV1.apiHost, ownerRuntime
            ? () => reportDetachedOwnerChannelStartupTiming(startupStartedAtMs, channelStartupStartedAtMs, stageTimings, initialization)
            : undefined);
        if (!ownerRuntime) {
            // Legacy/non-owner hosts retain their established fail-closed startup contract.
            await awaitNonOwnerChannelStartup({
                run: () => measureStageAsync('channel_startup_ms', () => channelStartup),
                report: (outcome) => reportStartupTimings({
                    totalMs: Math.max(0, Date.now() - startupStartedAtMs),
                    stages: stageTimings,
                    initialization,
                    outcome,
                }),
            });
        }
        ownerCompromiseGuard.publish();
        ownerRuntime?.background.startMaintenance();
        return createStartedHost(v1, ownerRuntime, cliService, v1.ready);
    }
    catch (error) {
        compatibility?.failConversation(error);
        await cleanupFailedStartup({
            ownerRuntime,
            v1,
            closeV1: legacyClose,
            agentOwner,
            agentTelemetry,
            database,
        });
        throw error;
    }
}
function createV1Compatibility(ownsV2Runtime) {
    if (!ownsV2Runtime)
        return undefined;
    return createV1RuntimeCompatibility(new DeferredRuntimeConversation(), {
        createQuestionnaireService: (host) => new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps()),
    });
}
async function startChannelSubsystemAfterOwnerAgentDefinitions(ownerRuntime, apiHost, onOwnerChannelStartupSettled) {
    try {
        if (ownerRuntime && !(await ownerRuntime.services.builtinAgentDefinitionsReady))
            return;
        await apiHost.startChannelSubsystem();
    }
    catch (error) {
        if (!ownerRuntime)
            throw error;
        try {
            logger.error({
                event: 'rootless_im_startup_detached_rejected',
                error_code: runtimeOwnerErrorCode(error),
            }, 'Detached Rootless IM startup rejected after core Runtime became ready');
        }
        catch {
            // Channel-only diagnostics cannot compromise an otherwise ready Runtime.
        }
    }
    finally {
        if (ownerRuntime)
            onOwnerChannelStartupSettled?.();
    }
}
function reportDetachedOwnerChannelStartupTiming(startupStartedAtMs, channelStartupStartedAtMs, stageTimings, initialization) {
    stageTimings.channel_startup_ms = Math.max(0, Date.now() - channelStartupStartedAtMs);
    reportStartupTimings({
        totalMs: Math.max(0, Date.now() - startupStartedAtMs),
        stages: stageTimings,
        initialization,
        outcome: 'ready',
    });
}
function createStartedHost(v1, ownerRuntime, cliService, ready) {
    return {
        ...v1,
        ...(ownerRuntime ? { application: ownerRuntime.services.application } : {}),
        ...(cliService ? { cliService } : {}),
        apiHost: v1.apiHost,
        ready,
        ...(ownerRuntime
            ? {
                notifyAuthContextChanged: (authState) => ownerRuntime.services.notifyAuthContextChanged(authState),
            }
            : {}),
    };
}
function createRuntimeOwnerCompromiseGuard(ownerRuntime, close) {
    const identity = ownerRuntime?.background.clients.runtimeOwnerIdentity;
    if (!identity)
        return { assertHealthy: () => undefined, publish: () => undefined };
    let published = false;
    let startupFailure;
    let compromiseClose;
    const unsubscribe = identity.onCompromised((error) => {
        if (!published) {
            startupFailure ??= error;
            return;
        }
        compromiseClose ??= closeCompromisedRuntime(identity.instanceId, error, close);
    });
    const assertHealthy = () => {
        if (!startupFailure)
            return;
        unsubscribe();
        throw startupFailure;
    };
    return {
        assertHealthy,
        publish: () => {
            assertHealthy();
            published = true;
        },
    };
}
async function closeCompromisedRuntime(instanceId, error, close) {
    logger.error({
        event: 'runtime_owner_lease_compromised',
        instance_id: instanceId,
        error_code: runtimeOwnerErrorCode(error),
    }, 'V2 Runtime owner lease compromised; closing Runtime');
    try {
        await close();
    }
    catch (closeError) {
        logger.error({
            event: 'runtime_owner_compromise_close_failed',
            instance_id: instanceId,
            error_code: runtimeOwnerErrorCode(closeError),
        }, 'V2 Runtime failed to close after owner lease compromise');
    }
}
function runtimeOwnerErrorCode(error) {
    if (!error || typeof error !== 'object' || !('code' in error))
        return 'UNKNOWN';
    const code = error.code;
    return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}
function isV2RuntimeOwner(options) {
    return ((options.runtimeOwnerKind === 'electron' && options.capabilities?.electronHost === true) ||
        ((options.runtimeOwnerKind === 'cli' || options.runtimeOwnerKind === 'tui') &&
            options.capabilities?.cliEmbedded === true));
}
export { createLocalRuntimeHostV2 as createLocalRuntimeHost };
/**
 * Emits one structured line accounting for every blocking startup stage.
 *
 * Restart latency after an update install is dominated by this path, and until
 * now the only local evidence was the gap between unrelated log lines. The line
 * is always emitted — including the fast no-migration case — so a slow start can
 * be compared against a normal one instead of only being visible when it hurts.
 *
 * `outcome` distinguishes a runtime that actually reached readiness from one
 * that died during channel startup, so a failed restart is never mistaken for a
 * fast one.
 */
function reportStartupTimings(input) {
    const { backup, pendingVersions, timings } = input.initialization;
    try {
        logger.info({
            outcome: input.outcome,
            total_ms: input.totalMs,
            ...input.stages,
            ...(timings
                ? {
                    db_initialize_backup_ms: timings.backupMs,
                    db_initialize_migrations_ms: timings.migrationsMs,
                    db_initialize_schema_check_ms: timings.schemaCheckMs,
                }
                : {}),
            pending_migration_count: pendingVersions?.length ?? 0,
            ...(pendingVersions && pendingVersions.length > 0
                ? { pending_migration_versions: pendingVersions }
                : {}),
            backup_created: backup?.created === true,
            ...(backup?.created
                ? {
                    backup_copy_ms: backup.backupMs,
                    backup_integrity_ms: backup.integrityMs,
                    ...(backup.sizeBytes === undefined ? {} : { backup_size_bytes: backup.sizeBytes }),
                }
                : {}),
        }, 'local-runtime-v2 startup timings');
    }
    catch {
        // Startup diagnostics are strictly observational: never let a malformed or
        // partially populated initialization result prevent the runtime from
        // starting.
    }
}
function reportLegacySessionRecovery(result) {
    if (result.recoveredLegacySessionCount <= 0 && result.degradedLegacySessionCount <= 0)
        return;
    logger.warn(result, 'local-runtime-v2 recovered or degraded malformed Session records before migration');
}
function reportProjectMigrationRecovery(result) {
    if (result.recoveredProjectPreferenceCount <= 0 && result.skippedSessionProjectRepairCount <= 0) {
        return;
    }
    logger.warn(result, 'local-runtime-v2 skipped malformed Project migration data');
}
function reportAgentCutover(event) {
    const fields = {
        migration_id: event.migrationId,
        ...(event.collisionMigrationId ? { collision_migration_id: event.collisionMigrationId } : {}),
        phase: event.phase,
        status: event.status,
        source_kind: event.sourceKind,
        target_kind: event.targetKind,
        conflict_count: event.conflictCount,
        mapping: event.mapping,
        reference_counts: event.referenceCounts,
        source_row_count: event.sourceRowCount,
        imported_row_count: event.importedRowCount,
        recovered_timestamp_count: event.recoveredTimestampCount,
        recoveries: event.recoveries,
        target_row_count: event.targetRowCount,
        duration_ms: event.durationMs,
        ...(event.failureStep ? { failure_step: event.failureStep } : {}),
        ...(event.secondaryFailureStep ? { secondary_failure_step: event.secondaryFailureStep } : {}),
        ...(event.skipCode ? { skip_code: event.skipCode } : {}),
        ...(event.errorCode ? { error_code: event.errorCode } : {}),
    };
    if (event.status === 'failed') {
        logger.error(fields, 'V2 Agent cutover failed');
        return;
    }
    logger.info(fields, 'V2 Agent cutover');
}
/**
 * Startup-only detached-identity record. The fields are deliberately bounded:
 * no Persona, Prompt, Memory, credential, avatar URL, or error text reaches
 * runtime logs.
 */
function reportAgentIdentityDetach(event) {
    const fields = {
        event: 'legacy_builtin_identity_detach',
        agent_name: event.agentName,
        phase: event.phase,
        outcome: event.outcome,
        ...(event.asset ? { asset: event.asset } : {}),
        ...(event.action ? { action: event.action } : {}),
        ...(event.avatarDecision ? { avatar_decision: event.avatarDecision } : {}),
    };
    if (event.outcome === 'failed') {
        logger.error(fields, 'V2 Agent identity detach failed');
        return;
    }
    logger.info(fields, 'V2 Agent identity detach');
}
function reportLegacyCustomAgentMaterialization(event) {
    if (event.kind === 'summary') {
        reportLegacyCustomAgentMaterializationSummary(event);
        return;
    }
    reportLegacyCustomAgentMaterializationAgent(event);
}
function reportLegacyCustomAgentMaterializationSummary(event) {
    const fields = {
        event: 'legacy_custom_agent_materialization_summary',
        materialized: event.materialized,
        canonical_identity_reconciled: event.canonicalIdentityReconciled,
        already_canonical: event.alreadyCanonical,
        not_legacy: event.notLegacy,
        invalid: event.invalid,
        failed: event.failed,
        receipt_completed: event.receiptCompleted,
    };
    if (event.invalid > 0 || event.failed > 0) {
        logger.warn(fields, 'V2 legacy Custom Agent materialization incomplete');
        return;
    }
    logger.info(fields, 'V2 legacy Custom Agent materialization summary');
}
function reportLegacyCustomAgentMaterializationAgent(event) {
    const deferred = event.outcome === 'invalid' || event.outcome === 'failed';
    const fields = {
        event: deferred
            ? 'legacy_custom_agent_materialization_deferred'
            : 'legacy_custom_agent_materialization',
        agent_name: event.agentName,
        outcome: event.outcome,
        identity_source: event.identitySource,
        recovered_fields: event.recoveredFields,
        ...(event.errorCode ? { error_code: event.errorCode } : {}),
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
    };
    if (deferred) {
        logger.warn(fields, 'V2 legacy Custom Agent materialization deferred');
        return;
    }
    logger.info(fields, 'V2 legacy Custom Agent materialization');
}
/** Fail-closed non-owner startup: channel errors abort with a failed timing report. */
async function awaitNonOwnerChannelStartup(input) {
    try {
        await input.run();
    }
    catch (error) {
        input.report('failed');
        throw error;
    }
    input.report('ready');
}
/** Post-initialization owner-runtime bindings (agent ports, channel owner, probes). */
function bindOwnerRuntimeIntegrations(input) {
    const { ownerRuntime, apiHost } = input;
    ownerRuntime.background.registerMaintenance('migration-backup-retention', async () => input.pruneBackups());
    bindV2AgentRuntimeManagementPort(input.agentRuntimePort, ownerRuntime, input.agentOwner);
    bindV2AgentLifecycle(apiHost, ownerRuntime.services.agent);
    bindV2ChannelSubsystem(apiHost, ownerRuntime.services.channelSystem);
    // Decision v3: late-bind the ask_user suppression probe now that the
    // V2 Turn system exists. V1-only hosts (and partial test graphs) keep
    // the probe unset, which means never suppress.
    bindAskUserSuppressionProbe(apiHost, ownerRuntime.services.turnSystem);
}
/**
 * MR2 two-phase assembly, phase 2: hand the v2-owned channel subsystem to
 * the v1 shell. Every legacy touchpoint (old REST routes, hosted transport,
 * cleanup) then lands on the single v2 owner. Electron-only: an embedded CLI
 * has no channel owner and the v1 shell keeps its internal
 * (capability-disabled) assembly, preserving the historical unsupported
 * semantics.
 */
function bindV2ChannelSubsystem(apiHost, channelSystem) {
    if (!channelSystem)
        return;
    apiHost.bindExternalChannelSubsystem(channelSystem.subsystem.hostFacadePort);
    // Test-only observability seam (runtime-composition acceptance drives the
    // v2-owned bridge infra of THIS runtime): exposed on the created host
    // without widening the public v1 type — hence the reflective set instead
    // of a cast. Production code never reads it; every production touchpoint
    // goes through the bound port above.
    Reflect.set(apiHost, 'channelBridgeInfra', channelSystem.subsystem.wired.channelBridgeInfra);
}
function configureV1HostOptions(options, compatibility, agentRuntimePort, owners) {
    const { sandboxOperationsFactory, prepared } = owners;
    const { browserAdapter, browserToolExposure, promptConfigKey, promptMode, wordEditor, excelEditor, ...v1Options } = options;
    void browserAdapter;
    void browserToolExposure;
    void promptConfigKey;
    void promptMode;
    void wordEditor;
    void excelEditor;
    // V2 owns the channel startup point: the V1 shell must build stores, APIs,
    // runner and registries without restoring a single transport.
    delete v1Options.computerUseClient;
    if (compatibility) {
        if (!prepared)
            throw new Error('V2 owner services were not prepared before V1 construction');
        return {
            ...compatibility.configureHostOptions({ ...v1Options, agentRuntimePort, sandboxOperationsFactory }, agentRuntimePort, prepared.v1),
            deferChannelStartup: true,
            // MR2: only the electron owner assembles the v2 channel subsystem; it
            // is bound after services exist (`bindExternalChannelSubsystem`). The
            // embedded CLI keeps the internal (capability-disabled) v1 assembly —
            // it has no channel owner by design, not by a runtime toggle.
            channelComposition: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
                ? 'external'
                : 'internal',
        };
    }
    return {
        ...v1Options,
        agentResolver: agentRuntimePort,
        agentRuntimePort,
        sandboxOperationsFactory,
        deferChannelStartup: true,
    };
}
function createFrontDoor(input) {
    const { v1, legacyHandleRequest, ownerRuntime, overrides, computerUseClient } = input;
    // The composer-send-behavior contract stores through the v1 host preference
    // store; hosts without an owner runtime keep the route unmounted and fall
    // through to the v1 fail-closed stub.
    const frontDoorServices = ownerRuntime
        ? {
            ...ownerRuntime.services,
            disabledLegacyScheduleCount: ownerRuntime.disabledLegacyScheduleCount,
        }
        : undefined;
    return createLocalRuntimeV2FrontDoor({
        logger,
        metrics: v1.metricsClient,
        legacyHandleRequest,
        ...(frontDoorServices ? { services: frontDoorServices } : {}),
        ...(frontDoorServices
            ? { ownerCapabilities: ownerCapabilitiesForServices(frontDoorServices) }
            : {}),
        ...(overrides.http?.onLegacyFallback
            ? { onLegacyFallback: overrides.http.onLegacyFallback }
            : {}),
        ...(ownerRuntime && computerUseClient ? { computerUseClient } : {}),
        ...(ownerRuntime?.services.computerUsePreferences
            ? { computerUsePreferences: ownerRuntime.services.computerUsePreferences }
            : {}),
    });
}
function bindV2AgentLifecycle(apiHost, agent) {
    apiHost.ensureBuiltinAgents = async () => {
        await agent.ensureBuiltinDefinitionsForPhase2();
    };
    apiHost.retryBuiltinGreetings = () => Promise.resolve();
}
function createBrowserUseServiceOptions(options) {
    return {
        ...(options.browserAdapter ? { adapter: options.browserAdapter } : {}),
        ...(options.browserToolExposure ? { toolExposure: options.browserToolExposure } : {}),
    };
}
async function initializeOwnerRuntime(input) {
    const { v1, compatibility, agentOwner, database, prepared, options, overrides, sandboxOperationsFactory, } = input;
    let background;
    let services;
    try {
        const startupExecutionEnabled = isLocalRuntimeStartupExecutionEnabled(options.startupExecutionPolicy);
        const electronOwner = options.runtimeOwnerKind === 'electron';
        background = await createBackgroundRuntime({
            db: database.db,
            dataDir: v1.dataDir,
            logger,
            metrics: v1.metricsClient,
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            restorePersistedJobExecution: startupExecutionEnabled,
            enableScheduler: electronOwner,
        });
        services = await createRuntimeServices({
            db: database.db,
            dataDir: v1.dataDir,
            logger,
            ...(background.clients.scheduler ? { scheduler: background.clients.scheduler } : {}),
            metrics: v1.metricsClient,
            eventBus: background.clients.eventBus,
            forkWorktree: background.clients.forkWorktree,
            compatibility: {
                create: (hosted) => compatibility.createServiceCompatibility(v1, options, hosted),
            },
            prepared,
            agentService: agentOwner.service,
            promptFileReader: agentOwner.promptFileReader,
            ...(options.configSource ? { configSource: options.configSource } : {}),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            recoverPersistedState: startupExecutionEnabled,
            greetingEnabled: electronOwner && startupExecutionEnabled,
            runtimeOwnerKind: options.runtimeOwnerKind,
            runtimeCapabilities: options.capabilities,
            browserUse: createBrowserUseServiceOptions(options),
            wordEditor: options.wordEditor,
            excelEditor: options.excelEditor,
            ...(options.promptConfigKey ? { promptConfigKey: options.promptConfigKey } : {}),
            capabilityProfile: options.capabilityProfile,
            getRunawayGuardConfig: options.getRunawayGuardConfig,
            ...(options.getToolResultCompactionConfig
                ? {
                    getToolResultCompactionConfig: options.getToolResultCompactionConfig,
                }
                : {}),
            runtimeOwnerIdentity: background.clients.runtimeOwnerIdentity,
            ...exposeComputerUseClient(options.computerUseClient),
            sessionClio: {
                // The V1 eval reporter owns the desktop gateway transport, so Session
                // Clio ships through it rather than opening its own route to the server.
                gateway: () => v1.evalReporterFactory,
                authContext: () => options.authContextGetter?.(),
                trajectoryId: buildLocalTrajectoryId,
                // Capture follows its own switch, not raw Eval sampling. Recording is
                // durable and offline-tolerant, so it stays on while a token is absent;
                // only the upload waits for receiving capabilities to be ready.
                enabled: () => v1.evalReporterFactory?.isClioCaptureEnabled?.() === true,
            },
            sandboxOperationsFactory,
            ...sandboxRuntimeOptions(options),
            ...(overrides.services ? { overrides: overrides.services } : {}),
        });
        const ownedServices = services;
        background.registerMaintenance('turn-diff-retention', () => ownedServices.sessionSystem.runStorageMaintenance());
        await background.start();
        await services.ready();
        return {
            database,
            background,
            services,
            disabledLegacyScheduleCount: input.disabledLegacyScheduleCount,
        };
    }
    catch (error) {
        await closeOwnerResources(background, services, 'startup cleanup');
        throw error;
    }
}
function exposeComputerUseClient(client) {
    return client ? { computerUseClient: client } : {};
}
function sandboxRuntimeOptions(options) {
    const sandboxConfig = options.configGetter?.().sandbox;
    return sandboxConfig ? { sandboxConfig } : {};
}
function createSharedClose(state) {
    let closePromise;
    return () => {
        if (!closePromise) {
            state.v1?.apiHost.beginShutdown();
            closePromise = closeRuntime(state);
        }
        return closePromise;
    };
}
async function closeRuntime({ ownerRuntime, closeV1, agentOwner, agentTelemetry, v1, database, }) {
    let firstError;
    await stopV1Producers(v1, (error) => {
        firstError ??= error;
    });
    await closeOwnerResources(ownerRuntime?.background, ownerRuntime?.services, 'close', (error) => {
        firstError ??= error;
    });
    try {
        agentTelemetry.close();
    }
    catch (error) {
        firstError ??= error;
    }
    try {
        agentOwner?.close();
    }
    catch (error) {
        firstError ??= error;
    }
    try {
        await closeV1?.();
    }
    catch (error) {
        firstError ??= error;
    }
    try {
        database?.close();
    }
    catch (error) {
        firstError ??= error;
    }
    if (firstError !== undefined)
        throw firstError;
}
async function closeOwnerResources(background, services, operation, recordError) {
    const steps = [
        ['stop_background', () => background?.stop()],
        ['close_services', () => services?.close()],
        ['close_background', () => background?.close()],
    ];
    for (const [cleanupStep, step] of steps) {
        try {
            await step();
        }
        catch (err) {
            recordError?.(err);
            try {
                logger.warn({ cleanupStep, err }, `local-runtime-v2 ${operation} failed`);
            }
            catch {
                // Resource cleanup and the original runtime failure remain primary.
            }
        }
    }
}
async function cleanupFailedStartup({ ownerRuntime, v1, closeV1, agentOwner, agentTelemetry, database, }) {
    await stopV1Producers(v1, (error) => {
        try {
            logger.warn({ cleanupStep: 'stop_v1_producers', err: error }, 'local-runtime-v2 startup cleanup failed');
        }
        catch {
            // Continue cleanup.
        }
    });
    await closeOwnerResources(ownerRuntime?.background, ownerRuntime?.services, 'startup cleanup');
    try {
        agentTelemetry.close();
    }
    catch (error) {
        try {
            logger.warn({ cleanupStep: 'close_agent_telemetry', err: error }, 'local-runtime-v2 startup cleanup failed');
        }
        catch {
            // Continue cleanup.
        }
    }
    try {
        agentOwner?.close();
    }
    catch (error) {
        try {
            logger.warn({ cleanupStep: 'close_agent_owner', err: error }, 'local-runtime-v2 startup cleanup failed');
        }
        catch {
            // Keep running cleanup even when reporting the owner failure fails.
        }
    }
    await cleanupFailedV1Startup(v1, closeV1, (cleanupStep, err) => {
        try {
            logger.warn({ cleanupStep, err }, 'local-runtime-v2 startup cleanup failed');
        }
        catch {
            // Continue cleanup even when reporting itself fails.
        }
    });
    try {
        database?.close();
    }
    catch (error) {
        try {
            logger.warn({ cleanupStep: 'close_database', err: error }, 'local-runtime-v2 startup cleanup failed');
        }
        catch {
            // Continue cleanup.
        }
    }
}
async function stopV1Producers(v1, recordError) {
    const steps = [
        () => v1?.apiHost.cronRuntime.stop(),
        () => v1?.apiHost.shutdownChannelSubsystem(),
    ];
    for (const step of steps) {
        try {
            await step();
        }
        catch (error) {
            recordError(error);
        }
    }
}
//# sourceMappingURL=runtime.js.map