import { createHash } from 'node:crypto';
import { composePluginHookToolResultContent, mergePluginHookContext, PluginHookCoordinator, renderPluginHookRejectionReminder, } from '@mavis/plugin-hooks';
import { buildRuntimeWarningEvent } from '@mavis/agent-core/event-bridge';
export { composePluginHookToolResultContent, mergePluginHookContext, renderPluginHookRejectionReminder, };
const SESSION_END_DRAIN_BUDGET_MS = 5_000;
const LOGOUT_FOREGROUND_BUDGET_MS = 5_000;
const MAX_PLUGIN_HOOK_WARNINGS_PER_EVENT = 8;
/** Keyed by one turn's event reporter object; collected with it. */
const warningEmissionStates = new WeakMap();
/**
 * Event ids and runtime sequence of one run of a turn. Every run restarts the
 * sequence at 1, so the ids of a continuation run also carry a short digest of
 * its lease: otherwise they repeat the ids an earlier run of the same turn
 * already delivered, and a host that deduplicates by event id drops them.
 */
export function createLocalPluginHookEventReporter(input) {
    let eventSequence = 0;
    let runtimeSequence = 0;
    const prefix = input.continuationLeaseId
        ? `evt_${input.turnId}_${leaseTag(input.continuationLeaseId)}`
        : `evt_${input.turnId}`;
    return {
        nextEventId: (kind) => `${prefix}_${kind}_${++eventSequence}`,
        nextRuntimeSeq: () => ++runtimeSequence,
        appendEvents: async (events) => input.writer.appendEvents(events),
        ...(input.terminalSequenceSurface
            ? { terminalSequenceSurface: input.terminalSequenceSurface }
            : {}),
    };
}
function leaseTag(leaseId) {
    return createHash('sha256').update(leaseId).digest('hex').slice(0, 8);
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
/**
 * Plugin Hook lifecycle owner of one harness instance, shared by its turns,
 * compaction and Session actions. A raw test bag without a Host config gets the
 * coordinator's own runner and no config hooks, resolver, fence or metrics.
 */
export class LocalPluginHooks {
    config;
    coordinator;
    /** SessionEnd warnings go to the reporter of the Session's last admitted turn. */
    sessionReporters = new Map();
    constructor(config) {
        this.config = config;
        this.coordinator = new PluginHookCoordinator(config?.runner, {
            onSessionEndResult: (input) => this.reportSessionEnd(input),
        });
        if (!config)
            return;
        const enabledPluginNames = config.enabledPluginNames;
        if (enabledPluginNames) {
            this.coordinator.setEnabledPluginResolver(() => this.withConfigHookOwners(enabledPluginNames()));
        }
        this.coordinator.setSessionEndFence(config.sessionEndFence);
        this.coordinator.configureObservability(pluginHookObservability(config));
    }
    /** The Host's `deferredExecutionReason`; undefined without a Host config or wording. */
    get deferredExecutionReason() {
        return this.config?.deferredExecutionReason;
    }
    /**
     * Vendor transcript of a turn or manual compaction. Rejects without a Host
     * factory, which callers treat like a failed write: null transcript paths.
     */
    createTranscript(input) {
        const create = this.config?.createTranscript;
        if (!create)
            return Promise.reject(new Error('No Host Plugin Hook transcript factory.'));
        return create(input);
    }
    /** Fail-open: config hooks never prevent a turn from running. */
    async loadConfigHooks(session) {
        const source = this.config?.configSource;
        if (!source || !session.workspaceDir)
            return [];
        try {
            return await source.load({
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
    async beginTurn(input, runtimeContext = {}) {
        const handlers = this.coordinator.handlersForTurn(input.lease.sessionId, input.pluginHooks ?? []);
        const effectiveInput = withEffectivePluginHookHandlers(input, handlers);
        const admitted = await this.runAdmission(input, runtimeContext, handlers);
        const transaction = this.bindAdmissionTransaction(input.lease.sessionId, admitted.transaction, localAdmissionReporter(input, handlers));
        await emitLocalPluginHookWarnings({
            reporter: input.pluginHookEventReporter,
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            event: 'SessionStart/UserPromptSubmit',
            result: admitted.result,
        });
        return admissionOutcome(admitted.result, transaction, effectiveInput);
    }
    markNextSessionStart(sessionId, source) {
        this.coordinator.markNextSessionStart(sessionId, source);
    }
    deactivatePlugin(pluginName) {
        this.coordinator.deactivatePlugin(pluginName);
    }
    async endSession(sessionId, reason, enabledPluginNames) {
        await this.coordinator.endSession(sessionId, reason, undefined, enabledPluginNames && this.withConfigHookOwners(enabledPluginNames));
    }
    async abortSessionTurn(sessionId, abortSession) {
        await settleWithin(Promise.allSettled(this.coordinator
            .activeExecutionSessionIds(sessionId)
            .map((executionSessionId) => abortSession(executionSessionId))), SESSION_END_DRAIN_BUDGET_MS);
    }
    endAllForLogout(enabledPluginNames, abortSession) {
        return settleWithin(this.endAllAfterBoundedAbort(enabledPluginNames, abortSession), LOGOUT_FOREGROUND_BUDGET_MS);
    }
    dispose() {
        this.sessionReporters.clear();
        return this.coordinator.dispose();
    }
    /** SessionEnd keeps config owners alongside enabled Plugins. */
    withConfigHookOwners(pluginNames) {
        const owners = this.config?.configSource?.enabledOwnerNames() ?? new Set();
        return owners.size ? new Set([...pluginNames, ...owners]) : pluginNames;
    }
    async runAdmission(input, runtimeContext, handlers) {
        let transaction;
        try {
            const result = await this.coordinator.beginTurn({
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
    bindAdmissionTransaction(sessionId, coordinatorTransaction, reporterEntry) {
        const reporters = this.sessionReporters;
        const previousReporter = reporters.get(sessionId);
        if (reporterEntry)
            reporters.set(sessionId, reporterEntry);
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
                if (!reporterEntry || reporters.get(sessionId) !== reporterEntry)
                    return;
                if (previousReporter)
                    reporters.set(sessionId, previousReporter);
                else
                    reporters.delete(sessionId);
            },
        };
    }
    reportSessionEnd(input) {
        const retained = this.sessionReporters.get(input.sessionId);
        this.sessionReporters.delete(input.sessionId);
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
    async endAllAfterBoundedAbort(enabledPluginNames, abortSession) {
        if (abortSession) {
            await settleWithin(Promise.allSettled(this.coordinator.activeExecutionSessionIds().map((sessionId) => abortSession(sessionId))), SESSION_END_DRAIN_BUDGET_MS);
        }
        await this.coordinator.endAllSessions('logout', undefined, enabledPluginNames && this.withConfigHookOwners(enabledPluginNames));
    }
}
function admissionOutcome(result, transaction, effectiveInput) {
    if (result.decision.continue === false) {
        return {
            kind: 'stop',
            reason: result.decision.stopReason ?? 'Turn stopped by Plugin Hook.',
            transaction,
        };
    }
    if (result.decision.decision === 'deny') {
        return {
            kind: 'deny',
            reason: result.decision.reason ?? 'User prompt was rejected by a Plugin Hook.',
            transaction,
        };
    }
    return {
        kind: 'continue',
        transaction,
        input: result.decision.additionalContext
            ? { ...effectiveInput, pluginHookContext: result.decision.additionalContext }
            : effectiveInput,
    };
}
function pluginHookObservability(config) {
    const { metrics, runtime } = config;
    return {
        ...(config.logger ? { logger: config.logger } : {}),
        ...(metrics
            ? {
                observer: {
                    onHandler: (event) => {
                        const labels = {
                            runtime,
                            event: event.event,
                            format: event.format,
                            origin: event.origin,
                            outcome: event.outcome,
                        };
                        metrics.counter('plugin_hook_handler_total', 1, labels);
                        metrics.histogram('plugin_hook_handler_duration_ms', event.durationMs, labels);
                        if (event.processKilled) {
                            metrics.counter('plugin_hook_process_killed_total', 1, {
                                runtime,
                                reason: event.outcome,
                            });
                        }
                    },
                    onEvent: (event) => {
                        const labels = { runtime, event: event.event, outcome: event.outcome };
                        metrics.counter('plugin_hook_event_total', 1, labels);
                        metrics.histogram('plugin_hook_event_duration_ms', event.durationMs, labels);
                    },
                },
            }
            : {}),
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