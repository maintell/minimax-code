import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBunnyEnabledInConfig, isBunnyMemoryEnabledInConfig } from '@mavis/config';
import { readPromptWithBuiltinFallback, renderBunnyHelperAgentSections, renderBunnyMemorySections, } from '../../service/agent/index.js';
import { resolveBuiltinPromptAssetsDir } from '../../service/prompt-config/index.js';
import { createGlobalMemoryModelCompletion, } from '../../service/turn-system/index.js';
import { MemoryExecutionLedger, MemorySubscriptionQuota, MemoryV2ModelGateway, resolveMemoryV2Config, } from '../../service/memory-system/index.js';
import { BUNNY_AGENT_NAME, bunnyMemoryRoot, memoryRelativePath, BunnyMemoryFileStore, BunnyMemorySessionSource, BunnyMemoryService, BunnyConversationSearch, createBunnyRememberTool, createConversationSearchTools, bindBunnyMemoryTriggers, BunnySpaceTidyService, recordingBunnyTraceSink, BunnyDebugResetService, createBunnyTaskTelemetry, createBunnyStoreSearchSpaceLinks, storedMediaDescriptions, memoryFailure, memoryModelFailure, } from '../../service/bunny/index.js';
import { clearWorkingStateLedger, initializeWorkingState, } from '../../service/working-state/index.js';
import { clearDeliveryBaselines } from '../../service/assignment/index.js';
import { composeBunnyOwners } from './bunny-composition.js';
import { createBunnyCompactionFeatures, readHandoffHeader } from './bunny-compaction-features.js';
import { gateBunnyCommunication } from './bunny-enabled-gate.js';
import { createTaskModelCheck } from './bunny-task-model-check.js';
import { startupRecoveryControls } from './runtime-services-lifecycle.js';
import { scopeEventsToCoordinatorSessions, } from './coordinator-turn-scope.js';
export function composeBunnyWithMemory(input, files, close, 
/** Binds the owners that ports created before Bunny read late. */
bindLate) {
    const state = input.bunnyState;
    const telemetry = state?.telemetry;
    const workingState = initializeWorkingState({
        db: input.options.bunnyDb,
        messages: input.options.db,
        nowMs: input.nowMs,
        agentName: BUNNY_AGENT_NAME,
        warn: (error) => telemetry?.failure({ scope: 'ledger', error }),
    });
    let spaceTidy;
    const memory = initializeRuntimeBunnyMemory(input, files, {
        // The ledger tool shares remember's main-conversation check and user-message source.
        tools: (source) => (identity) => workingState.tools(source, identity),
        readWorkingState: () => workingState.service.renderEvidence(),
        // The daily idle window tidies space summaries right after memory upkeep.
        afterLint: {
            run: async () => spaceTidy?.run(),
            stop: () => spaceTidy?.stop(),
        },
        // Spec 8.4: the user editing or deleting memory in settings refreshes the next Turn's prompt.
        ...(state
            ? { memoryEdited: () => state.prefixes.memoryEdited(), memoryRead: state.memoryReads.read }
            : {}),
        ...(telemetry ? { telemetry } : {}),
    });
    spaceTidy = new BunnySpaceTidyService({
        spaces: spaceTidySpaces(input.sessionSystem.artifactCatalog.library),
        model: { run: (work) => memory.runBackgroundModel({ ...work, kind: 'tidy' }) },
        readPrompt: () => memory.readPrompt('space-tidy.md'),
        nowMs: input.nowMs,
        warn: (error) => telemetry?.failure({ scope: 'memory', error: memoryFailure(error) }),
    });
    const modelConfig = input.product.preparation.configBuilder.config;
    const bunny = composeBunnyOwners({
        ...input.options,
        // Reset and restore replace the memory directory; a restored memory over the limit is evicted.
        withMemoryLock: (run) => memory.service.store.withReplacement(run),
        workingState: workingState.service,
        ...(state
            ? {
                bunnyState: {
                    prefixes: state.prefixes,
                    conversationSearch: memory.conversationSearch,
                    ...(input.options.getBunnyContextConfig
                        ? { getBunnyContextConfig: input.options.getBunnyContextConfig }
                        : {}),
                    memoryUnreadable: state.memoryReads.unreadable,
                    // A part a Turn left out is traced where the coordinator's handlings are (12.1).
                    emergencyTrace: segmentTraceSink(state, input.product.runner),
                },
                trace: state.traceStore,
            }
            : {}),
        ...(telemetry ? { telemetry } : {}),
        handoffHeader: (sessionId) => readHandoffHeader(input.sessionSystem.canonicalHistory, sessionId),
    }, input.sessionSystem, {
        ...input.owners,
        // The Bunny beta switch holds task reports and handoff notices for Bunny.
        runtimeConversation: gateBunnyCommunication(input.owners.runtimeConversation, () => isBunnyEnabledInConfig(modelConfig())),
        modelConfig,
        taskModelCheck: createTaskModelCheck({ config: modelConfig, resolver: input.preparation }),
        ...(input.listModels ? { listModels: input.listModels } : {}),
    }, input.nowMs);
    bindLate(bunny.services);
    // Spec 8.3: the user's MCP changes refresh Bunny's frozen tools next Turn.
    if (state)
        input.owners.mcp.runtime.onDidChangeServers(() => state.prefixes.toolSettingsChanged());
    // Everything Bunny's Turns read from the Bunny owners, bound in one go.
    input.owners.turnSystem.bindCoordinatorExtension({
        memoryTools: memory.memoryTools,
        memoryPrompt: memory.memoryPrompt,
        segmentFeatures: createBunnyCompactionFeatures({
            workingState: workingState.service,
            worklines: bunny.services.worklines,
            assignments: bunny.services.assignments,
            stateView: bunny.services.stateView,
            messages: input.sessionSystem.repositories.messages,
            conversationSearch: memory.conversationSearch,
            nowMs: input.nowMs,
        }),
        ...lateTurnStateParts(state, input.product.runner),
    });
    const lifecycle = bunny.lifecycle(memory.readyOwners(input.owners.miniAppComposition.ready), close);
    const cron = input.owners.cron;
    return {
        services: {
            ...bunny.services,
            bunnyStoreState: input.options.bunnyStore,
            bunnyTaskTelemetry: createBunnyTaskTelemetry(input.options.runtimeOwnerKind, input.options.bunnyStore),
            bunnyMemory: memory.service,
            workingState: workingState.service,
            bunnyConversationSearch: memory.conversationSearch,
            ...(state ? { bunnyTrace: state.traceStore } : {}),
            bunnyDebug: new BunnyDebugResetService({
                db: input.options.db,
                bunnyDb: input.options.bunnyDb,
                dataDir: input.options.dataDir,
                activeTurnId: (sessionId) => input.owners.turnSystem.inspection?.activeTurnId(sessionId),
                // Absent on the embedded CLI, which has no Cron owner; the reset then reports 0 routines.
                deleteRoutine: cron
                    ? async (cronId) => {
                        await cron.service.deleteDefinition({ cronId }, { mutationSource: 'system' });
                    }
                    : undefined,
                withMemoryLock: (run) => memory.service.store.withLock(run),
                clearDeliveryBaseline: clearDeliveryBaselines,
                clearWorkingState: clearWorkingStateLedger,
                reloadTaskIndex: () => input.sessionSystem.repositories.assignmentTasks.reloadAssigners(),
                nowMs: input.nowMs,
            }),
        },
        ready: lifecycle.ready,
        recoverAssignments: bunny.recoverAssignments,
        recovery: (owner, beginClose) => memory.recovery(owner, async () => {
            workingState.service.stop();
            await lifecycle.close();
        }, 
        // A store that holds nothing has no ledger entry to expire.
        () => {
            if (input.options.bunnyStore.hasData())
                workingState.service.start();
        }, beginClose),
    };
}
/** Bunny's Turn state and the trace segment compaction reports to, once the late state exists. */
function lateTurnStateParts(state, runner) {
    if (!state)
        return {};
    return {
        turnState: state.port,
        segmentTrace: segmentTraceSink(state, runner),
        segmentReset: state.segmentRebuilt,
    };
}
/**
 * The trace segment compaction and the emergency rebuild report to: recorded for Developer
 * Tools, then projected to Session Clio (spec 17.1); the telemetry also reports each
 * compaction's result.
 */
function segmentTraceSink(state, runner) {
    return (state.telemetry?.segmentTrace() ??
        recordingBunnyTraceSink(state.traceStore, runner?.evalReporterFactory));
}
export function initializeRuntimeBunnyMemory(input, files, extras = {}) {
    const telemetry = extras.telemetry;
    const memoryWritten = (write) => telemetry?.memoryWritten(write);
    const conversationSearch = new BunnyConversationSearch({
        db: input.options.db,
        spaces: createBunnyStoreSearchSpaceLinks(input.options.bunnyDb),
        descriptions: storedMediaDescriptions(input.options.bunnyDb),
        nowMs: input.nowMs,
        warn: (error) => telemetry?.failure({ scope: 'search', error }),
    });
    const memory = initializeBunnyMemory({
        readWorkingState: extras.readWorkingState,
        ...(extras.afterLint ? { afterLint: extras.afterLint } : {}),
        ...input.options,
        preparation: input.preparation,
        config: input.product.preparation.configBuilder.config,
        promptSnapshots: input.product.promptSnapshots,
        quota: input.options.compatibility.sessionHandoff.cloud,
        nowMs: input.nowMs,
        // A known kind of memory failure is counted under its own code (spec 3.10).
        warn: (error) => telemetry?.failure({ scope: 'memory', error: memoryFailure(error) }),
        memoryWritten,
        // The consolidator checks notes against the main conversation's original text.
        search: {
            mainSessionId: () => conversationSearch.currentMainSessionId(),
            search: (sessionId, args) => conversationSearch.search(sessionId, args, { inTurn: false }),
            read: (sessionId, args) => conversationSearch.read(sessionId, args),
        },
    });
    const extra = extras.tools?.(memory.service.source);
    // `remember` follows the memory switch (see `memory.tools`); the history tools and the
    // working-state ledger are not memory and stay either way.
    const memoryTools = (identity) => [
        ...memory.tools(identity),
        ...createConversationSearchTools(conversationSearch, identity, (tool, ms, turn) => telemetry?.searched(tool, ms, turn)),
        ...(extra?.(identity) ?? []),
    ];
    const memoryRoot = bunnyMemoryRoot(input.options.dataDir);
    files.bindSaveInterceptor(async (path, content, save) => {
        let result;
        try {
            result = await memory.service.store.editFile(path, content, save);
        }
        catch (error) {
            if (await isMemoryFile(memoryRoot, path))
                memoryWritten({ op: 'edit', outcome: 'failed' });
            throw error;
        }
        if ((await memoryRelativePath(memoryRoot, path)) !== undefined) {
            extras.memoryEdited?.();
            memoryWritten({ op: 'edit', outcome: 'ok' });
        }
        return result;
    });
    return {
        service: memory.service,
        conversationSearch,
        /** The background model, for the space tidy's own runs outside any Turn. */
        runBackgroundModel: memory.runBackgroundModel,
        /** A Bunny prompt asset, read with the builtin fallback the memory prompts use. */
        readPrompt: memory.readPrompt,
        /** remember, conversation search and the extra tools, for Bunny's Turns. */
        memoryTools,
        /**
         * The `<bunny-memory>` block that closes Bunny's system prompt; whether memory could be read
         * for it is recorded per Session (emergency rebuild spec 7.1). Off, the block is empty and the
         * existing file is left alone.
         */
        memoryPrompt: async ({ sessionId }) => {
            if (!isBunnyMemoryEnabledInConfig(input.product.preparation.configBuilder.config()))
                return '';
            let readable = true;
            const text = await memory.service.renderBunnyMemory(() => {
                readable = false;
            });
            extras.memoryRead?.(sessionId, readable);
            return text;
        },
        readyOwners: (ready) => async () => {
            await ready();
            // A user who never entered Bunny gets no memory directory and no background upkeep;
            // the first Bunny main-conversation event prepares memory (see the triggers). Off, nothing
            // is prepared: no directory is created and no stored idle timer is armed.
            if (conversationSearch.hasMainConversation() &&
                isBunnyMemoryEnabledInConfig(input.product.preparation.configBuilder.config()))
                await memory.ready();
        },
        recovery: (lifecycle, close, startOwners, beginClose) => {
            const recovery = startupRecoveryControls(lifecycle, async () => {
                await conversationSearch.close();
                await memory.close();
                await close();
            }, beginClose);
            return {
                ...recovery,
                startStartupRecovery: () => {
                    if (input.options.recoverPersistedState !== false) {
                        // Memory's own upkeep starts only while it is on; conversation backfill serves Bunny's
                        // Turns either way.
                        if (conversationSearch.hasMainConversation()) {
                            if (isBunnyMemoryEnabledInConfig(input.product.preparation.configBuilder.config()))
                                memory.start();
                            conversationSearch.startBackfill();
                        }
                        startOwners?.();
                    }
                    return recovery.startStartupRecovery();
                },
            };
        },
    };
}
/**
 * The space summaries the tidy reads and its one checked write, over the artifact catalog's
 * library: `readContext` is the same read `mavis space context read` does, and `tidyContext`
 * the same serialized write, with the replaced summary moved to the archive.
 */
function spaceTidySpaces(library) {
    return {
        list: () => library.summary().spaces.map((space) => {
            const context = library.readContext(space.id);
            return {
                id: space.id,
                name: space.name,
                goal: context.goal,
                summary: context.summary,
                revision: context.revision,
            };
        }),
        publish: (input) => library.tidyContext(input),
    };
}
/** Whether a failed save was of a memory file; a path that cannot be resolved is not. */
async function isMemoryFile(memoryRoot, path) {
    try {
        return (await memoryRelativePath(memoryRoot, path)) !== undefined;
    }
    catch {
        return false;
    }
}
/** A capture or lint run as a memory write: done, held back, or failed for the model. */
function memoryRunOutcome(result) {
    if (result.status === 'ok')
        return 'ok';
    return result.reason === 'model-unavailable' ? 'failed' : 'skipped';
}
function retryTime(error) {
    return typeof error === 'object' && error !== null && 'retryAtMs' in error
        ? Number(error.retryAtMs)
        : 0;
}
function initializeBunnyMemory(options) {
    const readPrompt = async (name) => {
        const key = `bunny/${name}`;
        const builtin = await readFile(join(await resolveBuiltinPromptAssetsDir(), key), 'utf8');
        return readPromptWithBuiltinFallback({ source: options.promptSnapshots, key, builtin });
    };
    const execution = new MemoryExecutionLedger(options.db, options.nowMs);
    const completion = createGlobalMemoryModelCompletion({
        preparation: options.preparation,
        defaultModelName: () => options.config().defaultModel ?? 'minimax/MiniMax-M3',
        nowMs: options.nowMs,
        modelCalls: execution.modelCalls,
    });
    const config = () => resolveMemoryV2Config({
        ...options.config().memory?.v2,
        captureReasoningEffort: 'low',
        consolidationReasoningEffort: 'medium',
    });
    const quota = options.quota
        ? new MemorySubscriptionQuota({ ...options.quota, nowMs: options.nowMs })
        : undefined;
    const gateway = new MemoryV2ModelGateway({
        config,
        completion,
        readPrompt: (kind) => readPrompt(kind === 'consolidation' ? 'memory-lint.md' : 'memory-capture.md'),
        readSubscriptionQuota: quota ? (name) => quota.read(name) : undefined,
    });
    const service = new BunnyMemoryService({
        store: new BunnyMemoryFileStore(options.dataDir, options.nowMs, options.warn),
        source: new BunnyMemorySessionSource(options.db, options.bunnyDb, options.nowMs),
        ledger: execution,
        readWorkingState: options.readWorkingState,
        ...(options.search ? { search: options.search } : {}),
        nowMs: options.nowMs,
        warn: options.warn,
        readPrompt,
        // The lint model reads the methods Bunny follows now, helper paragraphs included or not.
        readMethods: async () => renderBunnyMemorySections(renderBunnyHelperAgentSections(await readPrompt('system-prompt.md'), options.config().bunny?.helperAgents === true), isBunnyMemoryEnabledInConfig(options.config())),
        // Off, no capture or lint runs, whoever asks: the idle timer, startup or developer replay.
        enabled: () => isBunnyMemoryEnabledInConfig(options.config()),
        model: {
            async run(input) {
                const result = await runBackgroundModel(input);
                options.memoryWritten({ op: input.kind, outcome: memoryRunOutcome(result) });
                return result;
            },
        },
    });
    /**
     * A background model run outside any Turn, under the memory pipeline's quota guard, model
     * choice and reporting: memory capture and lint, and the space context tidy.
     */
    async function runBackgroundModel(input) {
        const kind = input.kind === 'capture' ? 'capture' : 'consolidation';
        const quotaState = await gateway.readQuota(kind);
        if (quotaState.status === 'available' &&
            [quotaState.fiveHour, quotaState.weekly].some((value) => typeof value === 'number' && value < 20))
            return { status: 'skipped', reason: 'quota-below-20-percent' };
        const reasoningEffort = input.kind === 'capture' ? 'low' : 'medium';
        const selected = kind === 'capture' ? config().captureModel : config().consolidationModel;
        try {
            const model = await completion.resolveModel({
                kind,
                reasoningEffort,
                modelName: selected,
            });
            const result = await completion.runToolLoop({
                kind,
                reasoningEffort,
                modelName: model.modelName,
                systemPrompt: input.prompt,
                briefing: input.briefing,
                tools: input.tools,
                maxTurns: 32,
                maxOutputTokens: model.maxOutputTokens,
                signal: input.signal,
            });
            if (result.status !== 'completed')
                throw new Error(result.status);
            return { status: 'ok' };
        }
        catch (error) {
            // The memory service backs off from this result; the failure is told by its kind.
            options.warn(memoryModelFailure(error));
            const retryAtMs = retryTime(error);
            return {
                status: 'skipped',
                reason: 'model-unavailable',
                ...(retryAtMs ? { retryAtMs } : {}),
            };
        }
    }
    const lifecycle = bindBunnyMemoryTriggers({
        service,
        scheduler: options.scheduler,
        nowMs: options.nowMs,
        events: scopeEventsToCoordinatorSessions(options.eventBus, options.mayCoordinate ?? (() => true)),
        warn: options.warn,
        enabled: () => isBunnyMemoryEnabledInConfig(options.config()),
        ...(options.afterLint ? { afterLint: options.afterLint } : {}),
    });
    return {
        service,
        ...lifecycle,
        /** The background model under the memory pipeline's quota guard, for the space tidy too. */
        runBackgroundModel,
        readPrompt,
        tools: (input) => input.agentName === BUNNY_AGENT_NAME && isBunnyMemoryEnabledInConfig(options.config())
            ? [createBunnyRememberTool(service, input, options.memoryWritten)]
            : [],
    };
}
//# sourceMappingURL=bunny-memory-composition.js.map