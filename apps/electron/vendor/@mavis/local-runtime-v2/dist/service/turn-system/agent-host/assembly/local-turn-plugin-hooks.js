import { composePluginHookToolResultContent, mergePluginHookContext, PluginHookCoordinator, PluginHookRunner, renderPluginHookRejectionReminder, } from '@mavis/plugin-hooks';
import { buildRuntimeWarningEvent } from '@mavis/agent-core/event-bridge';
export { composePluginHookToolResultContent, mergePluginHookContext, renderPluginHookRejectionReminder, };
const sessionReporters = new Map();
/** Process-local lifecycle owner shared by Desktop turns, compaction, and session actions. */
export const localPluginHookCoordinator = new PluginHookCoordinator(new PluginHookRunner(), {
    onSessionEndResult: reportLocalPluginHookSessionEnd,
});
const SESSION_END_DRAIN_BUDGET_MS = 5_000;
const LOGOUT_FOREGROUND_BUDGET_MS = 5_000;
const MAX_PLUGIN_HOOK_WARNINGS_PER_EVENT = 8;
const warningEmissionStates = new WeakMap();
export function createLocalPluginHookEventReporter(input) {
    let eventSequence = 0;
    let runtimeSequence = 0;
    return {
        nextEventId: (kind) => `evt_${input.turnId}_${kind}_${++eventSequence}`,
        nextRuntimeSeq: () => ++runtimeSequence,
        appendEvents: async (events) => input.writer.appendEvents(events),
        ...(input.terminalSequenceSurface
            ? { terminalSequenceSurface: input.terminalSequenceSurface }
            : {}),
    };
}
export async function emitLocalPluginHookWarnings(input) {
    if (!input.reporter)
        return;
    const reporter = input.reporter;
    await withWarningEmissionLane(reporter, async (seen) => {
        const decision = input.result?.decision ?? input.decision;
        const warningCandidates = [];
        if (input.message) {
            warningCandidates.push({ category: 'runtime-message', message: input.message });
        }
        if (decision?.systemMessage) {
            warningCandidates.push({ category: 'system-message', message: decision.systemMessage });
        }
        if (decision?.terminalSequence) {
            warningCandidates.push(reporter.terminalSequenceSurface === 'tui'
                ? {
                    category: 'terminal-control',
                    message: '',
                    terminalSequence: decision.terminalSequence,
                }
                : {
                    category: 'terminal-control',
                    message: 'A Plugin Hook requested terminal control output, but this runtime surface does not execute terminal control sequences.',
                });
        }
        warningCandidates.push(...(input.result?.diagnostics ?? []).map((diagnostic) => ({
            category: 'diagnostic',
            message: diagnosticWarningMessage(diagnostic.pluginName, input.event, diagnostic.code),
            code: diagnostic.code,
            pluginName: diagnostic.pluginName,
        })));
        const warnings = warningCandidates.filter((warning) => warning.message.trim().length > 0 || Boolean(warning.terminalSequence));
        const uniqueWarnings = [
            ...new Map(warnings.map((warning) => [
                `${warning.category}\u0000${warning.message}\u0000${warning.terminalSequence ?? ''}`,
                warning,
            ])).values(),
        ]
            // Each Hook invocation may intentionally repeat a user-facing message.
            // Only diagnostics/control notices are deduplicated across invocations.
            .filter((warning) => warning.category === 'system-message' || !seen.has(warningDedupeKey(input, warning)))
            .slice(0, MAX_PLUGIN_HOOK_WARNINGS_PER_EVENT);
        if (uniqueWarnings.length === 0)
            return;
        try {
            await reporter.appendEvents(uniqueWarnings.map((warning) => {
                const eventId = reporter.nextEventId('runtime_warning');
                return buildRuntimeWarningEvent({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    eventId,
                    runtimeSeq: reporter.nextRuntimeSeq(),
                    message: warning.message,
                    source: 'plugin-hook',
                    category: warning.category,
                    hookEvent: input.event,
                    ...(warning.code ? { code: warning.code } : {}),
                    ...(warning.pluginName ? { pluginName: warning.pluginName } : {}),
                    ...(warning.terminalSequence ? { terminalSequence: warning.terminalSequence } : {}),
                });
            }));
            for (const warning of uniqueWarnings.filter((item) => item.category !== 'system-message')) {
                seen.add(warningDedupeKey(input, warning));
            }
        }
        catch {
            // Warning delivery is best-effort and must not alter Hook control flow.
        }
    });
}
function warningDedupeKey(input, warning) {
    return [
        input.sessionId,
        input.turnId,
        warning.pluginName ?? '',
        input.event,
        warning.code ?? warning.category,
    ].join('\0');
}
function diagnosticWarningMessage(pluginName, event, code) {
    const outcome = event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse'
        ? 'The tool execution and result were not changed by this Hook.'
        : 'The conversation continued without this Hook.';
    const owner = describeHookOwner(pluginName);
    if (code === 'HOOK_INVALID_INPUT') {
        return `A compatibility-limited ${owner.subject} was skipped during ${event}. ${outcome}`;
    }
    if (code === 'HOOK_TIMEOUT') {
        return `${owner.title} timed out and was skipped during ${event}. ${outcome}`;
    }
    return `${owner.title} could not complete and was skipped during ${event}. ${outcome}`;
}
/** Config-file hooks use host owner ids (`@user/...`, `@project/...`), never Plugin names. */
function describeHookOwner(pluginName) {
    if (pluginName.startsWith('@user/'))
        return { title: 'A user Hook', subject: 'user Hook' };
    if (pluginName.startsWith('@project/')) {
        return { title: 'A project Hook', subject: 'project Hook' };
    }
    return { title: `Plugin "${pluginName}" Hook`, subject: `Hook from Plugin "${pluginName}"` };
}
let localConfigHookSource;
/** Binds user/project config hooks; they are read once per turn after preflight. */
export function configureLocalConfigHookSource(source) {
    localConfigHookSource = source;
}
/** Fail-open: config hooks never prevent a turn from running. */
export async function loadLocalConfigHooks(session) {
    if (!localConfigHookSource || !session.workspaceDir)
        return [];
    try {
        return await localConfigHookSource.load({
            workspaceDir: session.workspaceDir,
            ...(session.runLocation?.parentRepoDir
                ? { parentRepoDir: session.runLocation.parentRepoDir }
                : {}),
            ...(session.isDefaultWorkspace ? { isDefaultWorkspace: true } : {}),
        });
    }
    catch {
        return [];
    }
}
function localConfigHookOwnerNames() {
    return localConfigHookSource?.enabledOwnerNames() ?? new Set();
}
/** SessionEnd keeps config owners alongside enabled Plugins. */
function withConfigHookOwners(pluginNames) {
    const owners = localConfigHookOwnerNames();
    return owners.size ? new Set([...pluginNames, ...owners]) : pluginNames;
}
async function withWarningEmissionLane(reporter, emit) {
    let state = warningEmissionStates.get(reporter);
    if (!state) {
        state = { seen: new Set() };
        warningEmissionStates.set(reporter, state);
    }
    const previous = state.lane;
    let release = () => undefined;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    state.lane = current;
    if (previous)
        await previous;
    try {
        await emit(state.seen);
    }
    finally {
        release();
        if (state.lane === current)
            state.lane = undefined;
    }
}
export async function beginLocalPluginHookTurn(input, runtimeContext = {}) {
    const handlers = localPluginHookCoordinator.handlersForTurn(input.lease.sessionId, input.pluginHooks ?? []);
    const effectiveInput = withEffectivePluginHookHandlers(input, handlers);
    const admitted = await runCoordinatorPluginHookAdmission(input, runtimeContext, handlers);
    const reporterEntry = localAdmissionReporter(input, handlers);
    const transaction = bindLocalAdmissionTransaction(input.lease.sessionId, admitted.transaction, reporterEntry);
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: 'SessionStart/UserPromptSubmit',
        result: admitted.result,
    });
    if (admitted.result.decision.continue === false) {
        return {
            kind: 'stop',
            reason: admitted.result.decision.stopReason ?? 'Turn stopped by Plugin Hook.',
            transaction,
        };
    }
    if (admitted.result.decision.decision === 'deny') {
        return {
            kind: 'deny',
            reason: admitted.result.decision.reason ?? 'User prompt was rejected by a Plugin Hook.',
            transaction,
        };
    }
    return {
        kind: 'continue',
        transaction,
        input: admitted.result.decision.additionalContext
            ? { ...effectiveInput, pluginHookContext: admitted.result.decision.additionalContext }
            : effectiveInput,
    };
}
function withEffectivePluginHookHandlers(input, handlers) {
    return handlers === input.pluginHooks ? input : { ...input, pluginHooks: handlers };
}
function localAdmissionReporter(input, handlers) {
    if (input.session.parentSessionId || handlers.length === 0 || !input.pluginHookEventReporter) {
        return undefined;
    }
    return { reporter: input.pluginHookEventReporter, turnId: input.lease.turnId };
}
async function runCoordinatorPluginHookAdmission(input, runtimeContext, handlers) {
    let transaction;
    try {
        const result = await localPluginHookCoordinator.beginTurn({
            handlers,
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            cwd: input.session.workspaceDir,
            ...runtimeContext,
            prompt: input.canonicalUserInput.text,
            resumeExistingSession: input.history.messages.length > 0,
            ...(input.session.parentSessionId ? { sessionStartSource: 'fork' } : {}),
            captureAdmissionTransaction: (captured) => {
                transaction = captured;
            },
            signal: input.lease.signal,
        });
        return { result, ...(transaction ? { transaction } : {}) };
    }
    catch (error) {
        await transaction?.rollback();
        throw error;
    }
}
function bindLocalAdmissionTransaction(sessionId, coordinatorTransaction, reporterEntry) {
    const previousReporter = sessionReporters.get(sessionId);
    if (reporterEntry)
        sessionReporters.set(sessionId, reporterEntry);
    let settled = false;
    return {
        commit: async () => {
            if (settled)
                return;
            settled = true;
            await coordinatorTransaction?.commit();
        },
        rollback: async () => {
            if (settled)
                return;
            settled = true;
            await coordinatorTransaction?.rollback();
            if (!reporterEntry || sessionReporters.get(sessionId) !== reporterEntry)
                return;
            if (previousReporter)
                sessionReporters.set(sessionId, previousReporter);
            else
                sessionReporters.delete(sessionId);
        },
    };
}
export function configureLocalPluginHookObservability(input) {
    localPluginHookCoordinator.configureObservability({
        ...(input.logger ? { logger: input.logger } : {}),
        ...(input.metrics
            ? {
                observer: {
                    onHandler: (event) => {
                        const labels = {
                            runtime: 'desktop',
                            event: event.event,
                            format: event.format,
                            origin: event.origin,
                            outcome: event.outcome,
                        };
                        input.metrics?.counter('plugin_hook_handler_total', 1, labels);
                        input.metrics?.histogram('plugin_hook_handler_duration_ms', event.durationMs, labels);
                        if (event.processKilled) {
                            input.metrics?.counter('plugin_hook_process_killed_total', 1, {
                                runtime: 'desktop',
                                reason: event.outcome,
                            });
                        }
                    },
                    onEvent: (event) => {
                        const labels = { runtime: 'desktop', event: event.event, outcome: event.outcome };
                        input.metrics?.counter('plugin_hook_event_total', 1, labels);
                        input.metrics?.histogram('plugin_hook_event_duration_ms', event.durationMs, labels);
                    },
                },
            }
            : {}),
    });
}
export function configureLocalPluginHookEnabledResolver(resolve) {
    localPluginHookCoordinator.setEnabledPluginResolver(() => withConfigHookOwners(resolve()));
}
export function configureLocalPluginHookSessionEndFence(fence) {
    localPluginHookCoordinator.setSessionEndFence(fence);
}
export function deactivateLocalPluginHooks(pluginName) {
    localPluginHookCoordinator.deactivatePlugin(pluginName);
}
export function markNextLocalPluginHookSessionStart(sessionId, source) {
    localPluginHookCoordinator.markNextSessionStart(sessionId, source);
}
export async function endLocalPluginHookSession(sessionId, reason, enabledPluginNames) {
    await localPluginHookCoordinator.endSession(sessionId, reason, undefined, enabledPluginNames && withConfigHookOwners(enabledPluginNames));
}
export async function abortLocalPluginHookSessionTurn(sessionId, abortSession) {
    await settleWithin(Promise.allSettled(localPluginHookCoordinator
        .activeExecutionSessionIds(sessionId)
        .map((executionSessionId) => abortSession(executionSessionId))), SESSION_END_DRAIN_BUDGET_MS);
}
export function endAllLocalPluginHookSessionsForLogout(enabledPluginNames, abortSession) {
    return settleWithin(endAllAfterBoundedAbort(enabledPluginNames, abortSession), LOGOUT_FOREGROUND_BUDGET_MS);
}
export function disposeLocalPluginHookSessions() {
    sessionReporters.clear();
    return localPluginHookCoordinator.dispose();
}
function reportLocalPluginHookSessionEnd(input) {
    const retained = sessionReporters.get(input.sessionId);
    sessionReporters.delete(input.sessionId);
    if (!retained || !input.result)
        return;
    return emitLocalPluginHookWarnings({
        reporter: retained.reporter,
        sessionId: input.sessionId,
        turnId: retained.turnId,
        event: 'SessionEnd',
        result: input.result,
    });
}
async function endAllAfterBoundedAbort(enabledPluginNames, abortSession) {
    if (abortSession) {
        await settleWithin(Promise.allSettled(localPluginHookCoordinator
            .activeExecutionSessionIds()
            .map((sessionId) => abortSession(sessionId))), SESSION_END_DRAIN_BUDGET_MS);
    }
    await localPluginHookCoordinator.endAllSessions('logout', undefined, enabledPluginNames && withConfigHookOwners(enabledPluginNames));
}
async function settleWithin(value, timeoutMs) {
    let timer;
    await Promise.race([
        settle(value),
        new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        }),
    ]);
    if (timer)
        clearTimeout(timer);
}
async function settle(value) {
    try {
        await value;
    }
    catch {
        // SessionEnd is best-effort; the original lifecycle action must continue.
    }
}
//# sourceMappingURL=local-turn-plugin-hooks.js.map