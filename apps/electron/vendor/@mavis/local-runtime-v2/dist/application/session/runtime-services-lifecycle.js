import { settleInBackground, } from '../../service/plugin-system/index.js';
import { abortLocalPluginHookSessionTurn, endLocalPluginHookSession, } from '../../service/turn-system/index.js';
import { createRuntimeGlobalEventWriter, } from '../events.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
import { createStartupRecoveryRunner, } from './startup-recovery.js';
import { describeError } from './turn-message-delivery.js';
export async function closeRuntimeServiceOwnersAfterFailure(input) {
    for (const close of [
        () => input.cron?.close(),
        () => input.memory?.close(),
        () => input.turnSystem?.close(),
        () => input.plugin?.close(),
        () => input.skillSystem?.close(),
        () => input.mcp?.close(),
        () => input.sessionSystem.close(),
        () => input.miniApp?.close(),
    ]) {
        try {
            await close();
        }
        catch {
            // The original startup failure remains authoritative after best-effort reverse drain.
        }
    }
}
export function createRuntimeServicesGlobalEventWriter(options, state, nowMs) {
    return createRuntimeGlobalEventWriter({
        isClosed: () => state.closed,
        nowMs,
        notifyContextReset: (sessionId) => options.compatibility.contextLifecycle.notifyContextReset(sessionId),
        notifyGreetingTurnTerminal: (turnId, status) => state.agentApplication?.notifyGreetingTurnTerminal?.(turnId, status),
        write: (event) => options.eventBus.write(event),
    });
}
export function createRuntimePluginSessionLifecycle(turnSystem, plugin) {
    return {
        runPluginHookSessionEndFence: turnSystem.sessionLifecycle.runExclusive,
        preparePluginHookSessionEnd: (sessionId) => abortLocalPluginHookSessionTurn(sessionId, (executionSessionId) => turnSystem.turns.abort({ sessionId: executionSessionId, reason: 'session-archive' })),
        endPluginHookSession: (sessionId) => endLocalPluginHookSession(sessionId, 'archive', plugin.enabledHookPluginNames()),
    };
}
export function createRuntimePluginAuthContextNotifier(input) {
    return async (authState) => {
        const enabledBeforeChange = input.enabledHookPluginNames();
        input.authContextChanged();
        if (authState !== 'logged_out')
            return;
        await input.endAllSessionsForLogout(enabledBeforeChange, input.abortSession);
    };
}
/**
 * Bind the Goal owner and settle its recovery facts, then the v1 conversation
 * compatibility. Goal take-over (which submits Turns) is a later lifecycle
 * step, after questionnaire recovery. A quarantined clone binds but never
 * recovers persisted Goals: the source data directory's runtime owns them.
 */
export function bindGoalConversation(goal, options, runtimeConversation) {
    return async () => {
        goal.bindConversation(runtimeConversation);
        if (options.recoverPersistedState !== false)
            await goal.recoverFacts();
        await options.compatibility.conversation.bind(runtimeConversation);
    };
}
/** What the services composition gives the lifecycle for startup expiry and startup recovery. */
export function startupRecoveryInputs(goal, options, runtimeConversation) {
    return {
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.startupRecoveryFault ? { startupRecoveryFault: options.startupRecoveryFault } : {}),
        expireStaleQuestionnaires: async () => {
            // Goal questionnaires are never bulk-expired.
            await options.compatibility.questionnaires.createService().expireOnStartup();
        },
        recoverQuestionnaires: recoverQuestionnairesGoalFirst(goal, options.compatibility),
        takeOverGoals: (signal) => goal.takeOver(runtimeConversation, signal),
    };
}
/**
 * The RuntimeServices startup recovery surface. Recovery steps use the Goal and
 * Turn owners, so close stops recovery before `closeOwners` releases them.
 */
export function startupRecoveryControls(lifecycle, closeOwners) {
    let closePromise;
    const close = async () => {
        await lifecycle.stopStartupRecovery();
        await closeOwners();
    };
    return {
        startStartupRecovery: lifecycle.startStartupRecovery,
        stopStartupRecovery: () => settleInBackground(lifecycle.stopStartupRecovery()),
        close: () => {
            closePromise ??= close();
            return closePromise;
        },
    };
}
/** Recover the Goal's own questionnaires before the v1 questionnaire service's. */
function recoverQuestionnairesGoalFirst(goal, compatibility) {
    return async (signal) => {
        await goal.recoverQuestionnaires(signal);
        if (signal?.aborted)
            return;
        await compatibility.questionnaires.createService().recoverOnStartup(signal ? { signal } : {});
    };
}
/**
 * A Sandbox that cannot initialize must not take the control plane down with
 * it: the service stays `failed` and Bash keeps failing closed, but the HTTP
 * surface has to stay up so the user can still disable or retry it.
 */
async function initializeSandboxWithoutBlockingStartup(input) {
    try {
        await input.sandbox.initialize();
    }
    catch (error) {
        input.reportFailure?.('sandbox-initialization', `owner=sandbox;component=local-sandbox;stage=startup-initialize;error=${describeError(error)}`);
    }
}
/**
 * Owns the dependency-ordered ready and close sequence of the composed services.
 * `ready()` covers service assembly and local reconciliation only; the host
 * starts the startup recovery in the background once it is fully assembled
 * (ADR local-runtime-v2-startup-recovery-after-ready).
 */
export function createRuntimeServicesLifecycle(input) {
    const recoverPersistedState = input.recoverPersistedState !== false;
    const logger = resolvePluginServiceLogger(input.logger);
    let unbindGlobalEventPublisher;
    let readyPromise;
    let closePromise;
    let coreReady = false;
    let startupRecovery;
    let backgroundAgentRecovery;
    let resolveBuiltinAgentDefinitionsReady;
    const builtinAgentDefinitionsReady = new Promise((resolve) => {
        resolveBuiltinAgentDefinitionsReady = resolve;
    });
    const readyServices = async () => {
        if (input.state.closed) {
            resolveBuiltinAgentDefinitionsReady(false);
            return;
        }
        for (const step of createRuntimeReadySteps(input, recoverPersistedState, () => {
            unbindGlobalEventPublisher = input.bindGlobalEventPublisher();
        })) {
            if (input.state.closed)
                return;
            await step();
        }
        // Quarantined Cron reports its engine start without recovering pending runs.
        if (!recoverPersistedState && !input.state.closed)
            await input.cron?.ready();
        if (input.state.closed)
            return;
        coreReady = true;
        backgroundAgentRecovery = startBackgroundAgentRecovery(input, resolveBuiltinAgentDefinitionsReady);
    };
    const startStartupRecovery = () => {
        if (startupRecovery)
            return startupRecovery.start();
        if (input.state.closed)
            return Promise.resolve('stopped');
        if (!coreReady)
            return Promise.resolve('skipped');
        if (!recoverPersistedState) {
            logger.info({ event: 'startup_recovery_skipped', reason: 'quarantined' }, 'Startup recovery skipped: startup execution is quarantined');
            return Promise.resolve('skipped');
        }
        startupRecovery = createStartupRecoveryRunner({
            steps: createStartupRecoverySteps(input),
            logger,
            ...(input.reportFailure ? { reportFailure: input.reportFailure } : {}),
            ...(input.startupRecoveryFault ? { fault: input.startupRecoveryFault } : {}),
        });
        return startupRecovery.start();
    };
    const stopStartupRecovery = async () => {
        await startupRecovery?.stop();
    };
    const unbindV1GlobalEventPublisher = () => {
        const unbind = unbindGlobalEventPublisher;
        unbindGlobalEventPublisher = undefined;
        unbind?.();
        return Promise.resolve();
    };
    const closeServices = async () => {
        input.state.closed = true;
        resolveBuiltinAgentDefinitionsReady(false);
        await stopStartupRecovery();
        try {
            await readyPromise;
        }
        catch {
            // Startup failure is handled by its owner; closing must still drain acquired services.
        }
        backgroundAgentRecovery?.controller.abort();
        await backgroundAgentRecovery?.settled;
        const failures = [];
        const closeSteps = [
            () => input.applications.backgroundTask.close(),
            () => input.applications.session.sideChat.close(),
            () => Promise.resolve(input.applications.session.handoff.close()),
            () => Promise.resolve(input.workspaceHtmlPreview.close()),
            () => Promise.resolve(input.plan.lifecycleReconciler.close()),
            () => Promise.resolve(input.shutdownConversation()),
            unbindV1GlobalEventPublisher,
            () => Promise.resolve(input.cron?.close()),
            () => Promise.resolve(input.memory?.close()),
            () => Promise.resolve(input.turnSystem.close()),
            () => Promise.resolve(input.closeBrowserUse?.()),
            () => Promise.resolve(input.disposePluginHookSessions?.()),
            () => Promise.resolve(input.plugin.close()),
            () => Promise.resolve(input.skillSystem.close()),
            () => Promise.resolve(input.mcp.close()),
            () => Promise.resolve(input.agentApplication.close()),
            () => Promise.resolve(input.workspaceFile.close()),
            () => Promise.resolve(input.workspaceIndexing.close()),
            () => Promise.resolve(input.workspaceGit.close()),
            () => Promise.resolve(input.sessionSystem.close()),
            () => Promise.resolve(input.sandbox.close()),
        ];
        for (const close of closeSteps) {
            try {
                await close();
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0)
            throw failures[0];
    };
    return {
        builtinAgentDefinitionsReady,
        ready: () => {
            readyPromise ??= readyServices();
            return readyPromise;
        },
        startStartupRecovery,
        stopStartupRecovery,
        close: () => {
            closePromise ??= closeServices();
            return closePromise;
        },
    };
}
/** Readiness: service assembly and local reconciliation that executes no left-over work. */
function createRuntimeReadySteps(input, recoverPersistedState, bindGlobalEventPublisher) {
    return [
        bindGlobalEventPublisher,
        () => input.sessionSystem.ready(),
        ...(recoverPersistedState ? [() => reconcilePreparedPlanDocuments(input)] : []),
        () => input.mcp.ready(),
        () => input.skillSystem.ready(),
        () => input.plugin.ready(),
        () => input.memory?.ready(),
        () => recoverPendingForksFailSoft(input),
        () => initializeSandboxWithoutBlockingStartup(input),
        () => input.turnSystem.ready(),
        () => input.bindConversation(),
        ...(recoverPersistedState ? [() => expireStaleQuestionnairesOnStartup(input)] : []),
    ];
}
/**
 * Startup recovery: work the last process left unfinished, run serially in the
 * background after readiness. A failed step is reported and the next one runs.
 */
function createStartupRecoverySteps(input) {
    return [
        {
            name: 'subagent-queue-dispatch',
            owner: 'turn-system',
            run: (signal) => input.turnSystem.recoverQueuedSubagents(signal),
        },
        {
            name: 'cloud-handoff-upload',
            owner: 'session-handoff',
            run: async (signal) => {
                await input.applications.session.handoff.recoverPendingUploads(signal);
            },
        },
        { name: 'questionnaire-recovery', owner: 'questionnaire', run: input.recoverQuestionnaires },
        // After questionnaire recovery, so a saved answer is injected before the
        // Goal's own continuation is queued behind it.
        { name: 'goal-takeover', owner: 'goal', run: input.takeOverGoals },
        {
            name: 'plan-lifecycle-recovery',
            owner: 'plan',
            run: (signal) => recoverPlanLifecycleOnStartup(input, signal),
        },
        {
            name: 'cron-recovery',
            owner: 'cron',
            // Cron's own close stops its recovery; nothing starts once recovery is aborted.
            run: async (signal) => {
                if (!signal.aborted)
                    await input.cron?.ready();
            },
        },
    ];
}
async function reconcilePreparedPlanDocuments(input) {
    try {
        await input.sessionSystem.planDocuments.reconcilePreparedDrafts();
    }
    catch (error) {
        input.reportFailure?.('plan-document-recovery', `owner=session-system;component=plan-document;stage=startup-reconcile;error=${describeError(error)}`);
    }
}
async function expireStaleQuestionnairesOnStartup(input) {
    try {
        await input.expireStaleQuestionnaires();
    }
    catch (error) {
        reportStartupFailure(input, 'questionnaire-recovery', `owner=questionnaire;stage=startup-expiry;error=${describeError(error)}`);
    }
}
/** A failed recovery keeps the existing backoff retry and is reported by the step runner. */
async function recoverPlanLifecycleOnStartup(input, signal) {
    try {
        await input.plan.lifecycleReconciler.recoverStartup(signal);
    }
    catch (error) {
        if (!input.state.closed && !signal.aborted) {
            input.plan.lifecycleReconciler.schedule('startup-recovery');
        }
        throw error;
    }
}
/**
 * Builtin definitions and legacy Custom Agent rows are repaired after core
 * readiness. Shutdown aborts later stages and drains an active mutation before
 * closing the Agent and database owners.
 */
function startBackgroundAgentRecovery(input, resolveBuiltinAgentDefinitionsReady) {
    if (input.state.closed) {
        resolveBuiltinAgentDefinitionsReady(false);
        return undefined;
    }
    const controller = new AbortController();
    let resolveSettled;
    const settled = new Promise((resolve) => {
        resolveSettled = resolve;
    });
    setImmediate(() => {
        settleInBackground((async () => {
            try {
                await runBackgroundAgentRecoverySafely(input, controller.signal, resolveBuiltinAgentDefinitionsReady);
            }
            finally {
                resolveSettled();
            }
        })());
    });
    return { controller, settled };
}
async function runBackgroundAgentRecoverySafely(input, signal, resolveBuiltinAgentDefinitionsReady) {
    if (input.state.closed || signal.aborted) {
        resolveBuiltinAgentDefinitionsReady(false);
        return;
    }
    try {
        await runBackgroundAgentRecovery(input, signal, resolveBuiltinAgentDefinitionsReady);
    }
    catch (error) {
        if (signal.aborted)
            return;
        reportStartupFailure(input, 'agent-startup-recovery', `owner=agent;stage=background-runner;error=${describeError(error)}`);
    }
    finally {
        resolveBuiltinAgentDefinitionsReady(false);
    }
}
async function runBackgroundAgentRecovery(input, signal, resolveBuiltinAgentDefinitionsReady) {
    let stage = 'builtin-definitions';
    let builtinDefinitionsReady = false;
    try {
        await input.agentApplication.ensureBuiltinDefinitionsForPhase2();
        if (signal.aborted)
            return;
        builtinDefinitionsReady = true;
        stage = 'legacy-custom-materialization';
        await input.agentApplication.materializeLegacyCustomAgents();
    }
    catch (error) {
        if (signal.aborted)
            return;
        reportStartupFailure(input, 'agent-startup-recovery', `owner=agent;stage=${stage};error=${describeError(error)}`);
    }
    finally {
        resolveBuiltinAgentDefinitionsReady(builtinDefinitionsReady && !signal.aborted);
    }
}
function reportStartupFailure(input, scope, message) {
    try {
        input.reportFailure?.(scope, message);
    }
    catch {
        // Diagnostics are side effects and cannot become a core readiness gate.
    }
}
async function recoverPendingForksFailSoft(input) {
    try {
        await input.applications.session.conversationMutation?.recoverPendingForks();
    }
    catch (error) {
        reportStartupFailure(input, 'pending-fork-recovery', `owner=session;stage=pending-fork-recovery;error=${describeError(error)}`);
    }
}
//# sourceMappingURL=runtime-services-lifecycle.js.map