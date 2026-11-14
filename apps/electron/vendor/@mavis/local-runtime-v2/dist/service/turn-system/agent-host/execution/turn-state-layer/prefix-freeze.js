/**
 * Bunny's cache layout (spec 8): within a segment the system prompt and the
 * tool definitions stay byte-identical, so the provider keeps hitting the same
 * prompt cache. A Bunny main conversation freezes both at the first Turn and
 * re-renders them only at the refresh points of 8.3 and 8.4.
 */
/** Spec 8.5: Messages protocol routes cache a prompt for five minutes ("short"). */
export const MESSAGES_PROTOCOL_PROMPT_CACHE_TTL_MS = 5 * 60_000;
/**
 * The prompt-cache lifetime of a route, or undefined while it is not known.
 * Managed routes and the Responses protocol have no measured value yet; an
 * unknown lifetime never refreshes on time alone (8.4).
 */
export function resolvePromptCacheTtlMs(route) {
    if (route.managedProvider === true)
        return undefined;
    return route.api.endsWith('-messages') ? MESSAGES_PROTOCOL_PROMPT_CACHE_TTL_MS : undefined;
}
/**
 * Process-local frozen prefixes, one per Bunny main conversation. A restart
 * renders afresh, which is also when the provider cache is most likely cold.
 *
 * - System prompt (with the memory it renders): refreshed after a segment
 *   rebuild, a cache expiry, a model switch, or the user editing or deleting
 *   memory in settings. Bunny's own `remember` inside the segment does not
 *   change it. A prompt frozen while memory could not be read, with unreadable
 *   items skipped on their own, is refreshed at the first Turn memory reads
 *   again (emergency rebuild spec 7.2).
 * - Tool definitions: refreshed after a segment rebuild, a cache expiry, a
 *   model switch, or the user changing plugins or MCP in settings.
 */
export class FrozenTurnPrefixes {
    frozen = new Map();
    rebuilt = new Set();
    memoryEpoch = 0;
    toolSettingsEpoch = 0;
    /** The user edited or deleted memory in settings: the next Turn renders it. */
    memoryEdited() {
        this.memoryEpoch += 1;
    }
    /** The user changed plugins or MCP in settings: the next Turn takes the new tools. */
    toolSettingsChanged() {
        this.toolSettingsEpoch += 1;
    }
    /** A segment rebuild committed for this conversation. */
    segmentRebuilt(sessionId) {
        if (this.frozen.has(sessionId))
            this.rebuilt.add(sessionId);
    }
    forget(sessionId) {
        this.frozen.delete(sessionId);
        this.rebuilt.delete(sessionId);
    }
    apply(input) {
        const previous = this.frozen.get(input.sessionId);
        const shared = sharedRefreshReason(previous, input, this.rebuilt.has(input.sessionId));
        this.rebuilt.delete(input.sessionId);
        const prompt = this.nextPrompt(previous, shared, input);
        const tools = this.nextTools(previous, shared, input);
        this.frozen.set(input.sessionId, {
            modelKey: input.modelKey,
            prompt: prompt.frozen,
            tools: tools.frozen,
        });
        return {
            systemPrompt: prompt.frozen.systemPrompt,
            ...(prompt.frozen.contextUsagePromptRanges
                ? { contextUsagePromptRanges: prompt.frozen.contextUsagePromptRanges }
                : {}),
            tools: tools.frozen.tools,
            refreshed: {
                ...(prompt.reason ? { systemPrompt: prompt.reason } : {}),
                ...(tools.reason ? { tools: tools.reason } : {}),
            },
            ...(prompt.frozen.memoryMissing ? { memoryLeftOut: true } : {}),
        };
    }
    nextPrompt(previous, shared, input) {
        const reason = shared ?? this.memoryRefresh(previous?.prompt, input.memoryUnreadable === true);
        if (previous && !reason)
            return { frozen: previous.prompt };
        return {
            frozen: {
                systemPrompt: input.systemPrompt,
                ...(input.contextUsagePromptRanges
                    ? { contextUsagePromptRanges: input.contextUsagePromptRanges }
                    : {}),
                memoryEpoch: this.memoryEpoch,
                ...(input.memoryUnreadable ? { memoryMissing: true } : {}),
            },
            ...(reason ? { reason } : {}),
        };
    }
    /** Memory changed since the prompt was frozen, or reads again after it could not. */
    memoryRefresh(frozen, memoryUnreadable) {
        if (frozen?.memoryEpoch !== this.memoryEpoch)
            return 'memory-edited';
        return frozen.memoryMissing && !memoryUnreadable ? 'memory-readable' : undefined;
    }
    nextTools(previous, shared, input) {
        const reason = shared ??
            (previous?.tools.toolSettingsEpoch !== this.toolSettingsEpoch
                ? 'tool-settings-changed'
                : undefined);
        if (previous && !reason)
            return {
                frozen: {
                    ...previous.tools,
                    tools: freezeTools(input, previous.tools.tools),
                },
            };
        return {
            frozen: { tools: input.tools, toolSettingsEpoch: this.toolSettingsEpoch },
            ...(reason ? { reason } : {}),
        };
    }
}
function sharedRefreshReason(previous, input, rebuilt) {
    if (!previous)
        return 'first-turn';
    if (rebuilt)
        return 'segment-rebuild';
    if (previous.modelKey !== input.modelKey)
        return 'model-changed';
    if (input.cacheTtlMs !== undefined &&
        input.lastModelRequestAtMs !== undefined &&
        input.nowMs - input.lastModelRequestAtMs > input.cacheTtlMs) {
        return 'cache-expired';
    }
    return undefined;
}
/**
 * The frozen tool set with this Turn's executable tools: same names, order and
 * definitions as when it froze. A frozen tool that is no longer available is
 * dropped; a tool that appeared since waits for the next refresh.
 */
function freezeTools(input, frozen) {
    const current = new Map(input.tools.map((tool) => [input.toolName(tool), tool]));
    return frozen.flatMap((tool) => {
        const live = current.get(input.toolName(tool));
        return live ? [input.freezeTool(live, tool)] : [];
    });
}
//# sourceMappingURL=prefix-freeze.js.map