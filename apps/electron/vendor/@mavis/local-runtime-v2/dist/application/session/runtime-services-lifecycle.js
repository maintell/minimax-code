import { settleInBackground, } from '../../service/plugin-system/index.js';
import { abortLocalPluginHookSessionTurn, endLocalPluginHookSession, } from '../../service/turn-system/index.js';
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
/** Owns the dependency-ordered ready and close sequence of the composed services. */
export function createRuntimeServicesLifecycle(input) {
    let unbindGlobalEventPublisher;
    let readyPromise;
    let closePromise;
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
        const startup = await prepareRuntimeStartupBeforeCron(input, input.recoverPersistedState !== false, () => {
            unbindGlobalEventPublisher = input.bindGlobalEventPublisher();
        });
        if (!startup.completed)
            return;
        await input.cron?.ready();
        if (startup.retryPlanLifecycleRecovery && !input.state.closed) {
            input.plan.lifecycleReconciler.schedule('startup-recovery');
        }
        if (input.state.closed)
            return;
        backgroundAgentRecovery = startBackgroundAgentRecovery(input, resolveBuiltinAgentDefinitionsReady);
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
        close: () => {
            closePromise ??= closeServices();
            return closePromise;
        },
    };
}
async function prepareRuntimeStartupBeforeCron(input, recoverPersistedState, bindGlobalEventPublisher) {
    for (const step of createRuntimeStartupSteps(input, recoverPersistedState, bindGlobalEventPublisher)) {
        if (input.state.closed)
            return { completed: false, retryPlanLifecycleRecovery: false };
        await step();
    }
    if (input.state.closed)
        return { completed: false, retryPlanLifecycleRecovery: false };
    const retryPlanLifecycleRecovery = recoverPersistedState
        ? await recoverPlanLifecycleOnStartup(input)
        : false;
    return { completed: !input.state.closed, retryPlanLifecycleRecovery };
}
function createRuntimeStartupSteps(input, recoverPersistedState, bindGlobalEventPublisher) {
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
        ...(recoverPersistedState
            ? [
                () => input.applications.session.handoff.recoverPendingUploads(),
                () => recoverQuestionnairesOnStartup(input),
            ]
            : []),
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
async function recoverQuestionnairesOnStartup(input) {
    try {
        await input.recoverQuestionnaires();
    }
    catch (error) {
        input.reportFailure?.('questionnaire-recovery', `owner=questionnaire;stage=startup-recovery;error=${describeError(error)}`);
    }
}
async function recoverPlanLifecycleOnStartup(input) {
    try {
        await input.plan.lifecycleReconciler.recoverStartup();
        return false;
    }
    catch {
        return true;
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