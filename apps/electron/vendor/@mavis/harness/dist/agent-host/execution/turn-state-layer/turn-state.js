import { resolveTurnWakeReasons } from '../../preparation/turn-wake-reasons.js';
import { declaresAssignmentSnapshotReminder, isTrustedCoordinatorTurn, } from '../../assembly/payload/local-turn-payload-transform.js';
import { createStateDeltaMessage } from './state-delta-message.js';
import { isHandoffHeader, splitTurnStateLayers } from './turn-layers.js';
import { resolvePromptCacheTtlMs } from './prefix-freeze.js';
/**
 * Bunny's main conversation gets its frozen prefix and a delta block (spec 8,
 * 9); every other Turn keeps the live prefix and gets no delta block.
 */
export async function resolveTurnPrefix(input, options, live, userText) {
    const state = await prepareTurnStateLayer(input, options.turnStateLayer?.(), live, {
        nowMs: (options.nowMs ?? Date.now)(),
        userText,
        segmentPrefixLength: options.segmentPrefixLength?.(input.lease.sessionId),
    });
    if (!state)
        return { ...live, deltaBlocks: [] };
    const { deltaBlock, ...prefix } = state;
    return { ...prefix, deltaBlocks: [deltaBlock] };
}
/**
 * The delta block and the frozen prefix of a Bunny main-conversation Turn, or
 * undefined for every other Turn. A failed state read never blocks the Turn.
 */
async function prepareTurnStateLayer(input, port, prefix, options) {
    if (!port || !declaresAssignmentSnapshotReminder(input))
        return undefined;
    const state = await readState(input, port, options);
    if (!state)
        return undefined;
    const sessionId = input.lease.sessionId;
    const cacheTtlMs = resolvePromptCacheTtlMs({
        api: input.preparation.llm.model.api,
        managedProvider: input.preparation.llm.managedProvider === true,
    });
    const frozen = port.prefixes.apply({
        sessionId,
        nowMs: options.nowMs,
        cacheTtlMs,
        lastModelRequestAtMs: lastModelRequestAtMs(input.history.messages),
        modelKey: `${input.preparation.llm.model.provider}/${input.preparation.llm.model.id}`,
        ...prefix,
        toolName: (tool) => tool.def.name,
        freezeTool: (live, frozenTool) => ({ ...live, def: frozenTool.def }),
        ...(state.withoutMemory === undefined ? {} : { memoryUnreadable: true }),
    });
    port.prefixApplied?.({
        sessionId,
        turnId: input.lease.turnId,
        refreshed: frozen.refreshed,
        systemPrompt: frozen.systemPrompt,
        toolDefinitions: frozen.tools.map((tool) => tool.def),
        historyMessages: input.history.messages.length,
        layers: splitTurnStateLayers({
            systemPrompt: frozen.systemPrompt,
            promptRanges: frozen.contextUsagePromptRanges,
            history: input.history.messages,
            segmentPrefixLength: options.segmentPrefixLength,
        }),
        ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
        ...(frozen.memoryLeftOut ? { memoryLeftOut: true } : {}),
    });
    const content = frozen.memoryLeftOut && state.withoutMemory !== undefined ? state.withoutMemory : state.content;
    return {
        deltaBlock: createStateDeltaMessage(content, options.nowMs),
        systemPrompt: frozen.systemPrompt,
        ...(frozen.contextUsagePromptRanges
            ? {
                contextUsagePromptRanges: frozen.contextUsagePromptRanges,
            }
            : {}),
        tools: frozen.tools,
    };
}
async function readState(input, port, options) {
    const lastRequestAtMs = lastModelRequestAtMs(input.history.messages);
    try {
        return await port.prepare({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            agentName: input.agent.agentName,
            wakeReasons: resolveTurnWakeReasons(input.request),
            userText: options.userText,
            origin: input.request.provenance.sourceContext?.['origin'],
            frontContextMessageIds: input.history.identityVector ?? [],
            currentMessageIds: startingMessageIds(input.request),
            ...(lastRequestAtMs === undefined ? {} : { lastModelRequestAtMs: lastRequestAtMs }),
            ...(isHandoffHeader(input.history.messages[0]) ? { compacted: true } : {}),
            nowMs: options.nowMs,
            signal: input.lease.signal,
        });
    }
    catch {
        // The state is context, not a precondition: the user's Turn still runs.
        return undefined;
    }
}
/** The user message IDs of the Turn's starting input. */
function startingMessageIds(request) {
    const members = request.immediateSendBatch?.members ?? [];
    return [
        ...(request.userMessageId ? [request.userMessageId] : []),
        ...members.map((member) => member.userMessageId),
    ];
}
/** When the conversation last got a model answer: the newest assistant message in history. */
function lastModelRequestAtMs(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object')
            continue;
        if (Reflect.get(message, 'role') !== 'assistant')
            continue;
        const timestamp = Reflect.get(message, 'timestamp');
        if (typeof timestamp === 'number' && Number.isFinite(timestamp))
            return timestamp;
    }
    return undefined;
}
/**
 * How a Bunny Turn takes steered user messages: every trusted coordinator Turn
 * marks them with a wake line (spec 4.4), and Bunny's main Turn gives each one
 * its own recall pointers (spec 15.7).
 */
export function coordinatorSteeringOptions(input, prepared, port) {
    return {
        wakeLineBeforeUserSteering: isTrustedCoordinatorTurn(input),
        ...steeredRecallPointers(input, prepared, port),
    };
}
/** Spec 15.7: a user message steered into Bunny's main Turn gets its own recall pointers. */
function steeredRecallPointers(input, prepared, port) {
    const recall = port?.steeredRecallPointers;
    if (!recall || !prepared.stateLayerApplied)
        return {};
    const frontContextMessageIds = input.history.identityVector ?? [];
    return {
        recallPointers: ({ userText, currentMessageIds }) => recall({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            userText,
            frontContextMessageIds,
            currentMessageIds,
        }),
    };
}
//# sourceMappingURL=turn-state.js.map