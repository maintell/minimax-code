import { emitLocalPluginHookWarnings } from '../../assembly/local-turn-plugin-hooks.js';
export function withPluginAutomaticCompactionLifecycle(hook, input, coordinator) {
    return async (hookInput) => {
        const decision = await hook(hookInput);
        if (decision?.type !== 'replaceMessages' ||
            !input.pluginHooks?.length ||
            !('compactionAttemptId' in decision.metadata) ||
            // An emergency rebuild is the Turn's recovery, not a compaction plugins see.
            Reflect.get(decision.metadata, 'segmentHidden') === true) {
            return decision;
        }
        const ownAfterCommit = decision.afterCommit;
        return {
            ...decision,
            // The compaction's own bookkeeping (a segment rebuild's) runs first.
            afterCommit: async () => {
                const own = await ownAfterCommit?.();
                return ((await finishAutomaticPluginCompaction(input, coordinator, decision.metadata.summary)) ??
                    own);
            },
        };
    };
}
async function finishAutomaticPluginCompaction(input, coordinator, summary) {
    coordinator.completeAutomaticCompaction(input.lease.sessionId);
    const postCompact = await runAutomaticPluginCompactionEvent(input, coordinator, 'PostCompact', {
        trigger: 'auto',
        compact_summary: summary,
    });
    if (!postCompact)
        return undefined;
    if (hasAbortedHook(postCompact)) {
        markAutomaticCompactionForRetry(input, coordinator);
        return undefined;
    }
    if (postCompact.decision.continue === false) {
        markAutomaticCompactionForRetry(input, coordinator);
        throw new PluginHookStopRequestedError(postCompact.decision.stopReason ?? 'Turn stopped by PostCompact Plugin Hook.');
    }
    const resumed = await runAutomaticPluginCompactionEvent(input, coordinator, 'SessionStart', {
        source: 'compact',
    });
    if (!resumed)
        return undefined;
    if (hasAbortedHook(resumed)) {
        markAutomaticCompactionForRetry(input, coordinator);
        return undefined;
    }
    if (resumed.decision.continue === false) {
        throw new PluginHookStopRequestedError(resumed.decision.stopReason ?? 'Turn stopped by SessionStart Plugin Hook.');
    }
    const context = resumed.decision.additionalContext?.trim();
    return context
        ? {
            role: 'custom',
            customType: 'plugin_hook_context',
            content: `<plugin-hook-context>\n${context}\n</plugin-hook-context>`,
            display: false,
            timestamp: Date.now(),
        }
        : undefined;
}
async function runAutomaticPluginCompactionEvent(input, coordinator, event, payload) {
    try {
        const result = await coordinator.runEvent(input.pluginHooks ?? [], {
            event,
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            cwd: input.session.workspaceDir,
            ...input.pluginHookRuntimeContext,
            matcherValue: event === 'SessionStart' ? 'compact' : 'auto',
            payload,
        }, input.lease.signal);
        await emitLocalPluginHookWarnings({
            reporter: input.pluginHookEventReporter,
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            event,
            result,
        });
        return result;
    }
    catch {
        markAutomaticCompactionForRetry(input, coordinator);
        return undefined;
    }
}
function hasAbortedHook(result) {
    const aborted = result.diagnostics.some((item) => item.code === 'HOOK_ABORTED');
    if (aborted)
        return true;
    return false;
}
function markAutomaticCompactionForRetry(input, coordinator) {
    coordinator.markCompacted(input.lease.sessionId, input.pluginHooks ?? []);
}
class PluginHookStopRequestedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PluginHookStopRequestedError';
    }
}
//# sourceMappingURL=plugin-hook-compaction-lifecycle.js.map