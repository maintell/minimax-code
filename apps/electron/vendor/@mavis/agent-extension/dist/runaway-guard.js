import { createRunawayGuard, } from '@mavis/runaway-guard';
// Keep the existing adapter API stable for hosts and offline Bench consumers.
export { replayRunawayGuardTrajectory, } from '@mavis/runaway-guard';
/** Observation-only adapter over the same Turn-local domain detector. */
export function runawayGuardShadowExtension(options = {}) {
    return createRunawayGuardExtension(options);
}
/** At most one Steer attempt per Turn; never rejects a tool or aborts a Turn. */
export function runawayGuardExtension(options = {}) {
    return createRunawayGuardExtension(options, options.remindAfterOccurrences ?? 3);
}
function createRunawayGuardExtension(options, afterOccurrences) {
    const guard = createRunawayGuard({
        toolPolicies: options.toolPolicies,
        maxFingerprintBytes: options.maxFingerprintBytes,
        onSignal: options.onSignal,
        remindAfterOccurrences: afterOccurrences,
    });
    const trustedToolProvenanceByTurn = new Map();
    const beforeToolCall = (event, _signal, ctx) => {
        try {
            if (!isEnabledBestEffort(options.isEnabled)) {
                guard.clearDetectionStreaks(ctx);
                clearTrustedToolProvenance(trustedToolProvenanceByTurn, ctx);
                return undefined;
            }
            const provenance = trustedTaskOutputProvenance(event.toolCall);
            if (provenance) {
                provenanceFor(trustedToolProvenanceByTurn, ctx).set(provenance.toolCallId, provenance);
            }
        }
        catch {
            // Provenance only gates a reminder; it never changes tool execution.
        }
        return undefined;
    };
    const onStepEnd = (event, ctx) => {
        if (event.signal.aborted) {
            guard.clearDetectionStreaks(ctx);
            clearTrustedToolProvenance(trustedToolProvenanceByTurn, ctx);
            return;
        }
        if (!isEnabledBestEffort(options.isEnabled)) {
            guard.clearDetectionStreaks(ctx);
            clearTrustedToolProvenance(trustedToolProvenanceByTurn, ctx);
            return;
        }
        try {
            const reminder = guard.observe(ctx, {
                message: event.message,
                toolResults: event.toolResults,
                blockedToolCalls: event.blockedToolCalls,
                trustedToolProvenance: takeTrustedToolProvenance(trustedToolProvenanceByTurn, ctx),
                verifiedProgress: readVerifiedProgressBestEffort(options.readVerifiedProgress, ctx, event.message),
            }, afterOccurrences !== undefined && shouldApplyReminder(options.shouldRemind, ctx));
            if (!reminder)
                return;
            event.agent.steer({ role: 'user', content: reminder.content, timestamp: Date.now() });
            guard.markReminderInjected(ctx);
            notifyBestEffort(options.onReminder, reminder.observation);
        }
        catch {
            // Detection, host facts, steering and observers must all fail open.
        }
    };
    return {
        id: options.id ?? (afterOccurrences === undefined ? 'runaway-guard-shadow' : 'runaway-guard'),
        description: options.description ??
            (afterOccurrences === undefined
                ? 'Observe bounded deterministic convergence signals without steering or stopping the Agent.'
                : 'Observe deterministic convergence signals and inject one bounded strategy reminder.'),
        init(pi) {
            if (afterOccurrences !== undefined)
                pi.on('before_tool_call', beforeToolCall);
            pi.on('on_step_end', onStepEnd);
            pi.on('turn_end', (_event, ctx) => {
                try {
                    const summary = guard.finishTurn(ctx);
                    if (summary)
                        notifyBestEffort(options.onTurnSummary, summary);
                }
                finally {
                    clearTrustedToolProvenance(trustedToolProvenanceByTurn, ctx);
                }
            });
        },
    };
}
function trustedTaskOutputProvenance(value) {
    const toolCall = value;
    if (typeof toolCall.id !== 'string' ||
        toolCall.id.length === 0 ||
        toolCall.name !== 'task_output') {
        return undefined;
    }
    if (toolCall.source === 'builtin') {
        return { toolCallId: toolCall.id, toolName: 'task_output', source: 'builtin' };
    }
    if (toolCall.source === undefined) {
        return {
            toolCallId: toolCall.id,
            toolName: 'task_output',
            source: 'captured-compatibility',
        };
    }
    return undefined;
}
function provenanceFor(values, ctx) {
    const key = provenanceKey(ctx);
    const existing = values.get(key);
    if (existing)
        return existing;
    const next = new Map();
    values.set(key, next);
    return next;
}
function takeTrustedToolProvenance(values, ctx) {
    const current = values.get(provenanceKey(ctx));
    clearTrustedToolProvenance(values, ctx);
    return current ? [...current.values()] : [];
}
function clearTrustedToolProvenance(values, ctx) {
    values.delete(provenanceKey(ctx));
}
function provenanceKey(ctx) {
    return `${ctx.sessionId}\u0000${ctx.turnId}`;
}
function isEnabledBestEffort(getter) {
    try {
        return getter ? getter() === true : true;
    }
    catch {
        return false;
    }
}
function shouldApplyReminder(predicate, ctx) {
    try {
        return predicate?.(ctx) ?? true;
    }
    catch {
        return false;
    }
}
function readVerifiedProgressBestEffort(reader, ctx, message) {
    if (!reader || message.role !== 'assistant')
        return [];
    const toolCallIds = message.content.flatMap((block) => block.type === 'toolCall' ? [block.id] : []);
    if (toolCallIds.length === 0)
        return [];
    try {
        return reader({ sessionId: ctx.sessionId, turnId: ctx.turnId, toolCallIds });
    }
    catch {
        return [];
    }
}
function notifyBestEffort(observer, observation) {
    if (!observer)
        return;
    try {
        Promise.resolve(observer(observation)).catch(() => undefined);
    }
    catch {
        // Observers never affect Turn execution or cleanup.
    }
}
//# sourceMappingURL=runaway-guard.js.map