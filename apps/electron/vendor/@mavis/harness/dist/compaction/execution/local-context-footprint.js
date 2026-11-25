import { Buffer } from 'node:buffer';
import { projectAgentMessagesForModel } from '@mavis/agent-core/pi-turn-runner';
import { countProjectedReplayMessages, createDefaultTokenEstimator } from '@mavis/context-manager';
/**
 * `measurePair()` measures both sides with `measureFresh()` and never consults a usage
 * anchor, so a paired footprint is a local estimate by construction - even for a measurer
 * whose `measure()` is anchored.
 *
 * Reported results carry this constant instead of a repeated literal so the claim has one
 * owner: if `measurePair` ever gains an anchor, this is the single line that has to change.
 */
export const PAIRED_FOOTPRINT_SOURCE = 'local_estimate';
export function createLocalContextFootprintMeasurer(options) {
    const tools = options.tools ?? [];
    const estimator = createDefaultTokenEstimator();
    const fixedMessages = [
        ...(options.systemPrompt ? [textMessage(options.systemPrompt)] : []),
        ...(tools.length > 0 ? [textMessage(strictStringify(tools))] : []),
    ];
    const fixedTokens = estimator.estimateMessages(fixedMessages);
    strictStringify({ systemPrompt: options.systemPrompt ?? '', tools, messages: [] });
    const projectForModel = (messages) => projectAgentMessagesForModel(messages, options.model).messages;
    /**
     * The single token-counting path, shared with checkpoint candidate selection. The full
     * local estimate and the anchored suffix both go through it, so a visual block is priced
     * by its real dimensions on either branch. Keeping a second copy of this arithmetic on the
     * anchored branch is exactly how the trigger and the donut drifted apart.
     */
    const countProjected = (projected) => countProjectedReplayMessages(projected, options.model);
    const measureFresh = (messages) => {
        const projected = projectForModel(messages);
        const inputTokens = fixedTokens + countProjected(projected);
        const serializedBytes = Buffer.byteLength(strictStringify({ systemPrompt: options.systemPrompt ?? '', tools, messages: projected }), 'utf8');
        validateFootprint(inputTokens, serializedBytes);
        return { inputTokens, serializedBytes };
    };
    /** Only the prompt baseline is provider-measured; the entire new suffix is estimated. */
    const measureDetailed = (messages) => {
        const fresh = measureFresh(messages);
        const match = options.usageAnchor?.state.resolve({
            key: options.usageAnchor.key,
            historyEpoch: options.usageAnchor.historyEpoch,
            messages,
        });
        if (!match)
            return { ...fresh, source: 'local_estimate' };
        // Keep the assistant with its tool results while projecting, otherwise results are
        // filtered as orphans. Output billing is not an input measure: hidden reasoning may
        // never be replayed. Count the actual replay text of this entire suffix instead.
        const suffix = projectForModel([match.anchoredMessage, ...match.trailingMessages]);
        const estimatedSuffixTokens = countProjected(suffix);
        const inputTokens = match.absoluteTokens + estimatedSuffixTokens;
        validateFootprint(inputTokens, fresh.serializedBytes);
        return {
            ...fresh,
            inputTokens,
            source: 'provider_anchor',
            anchoredPromptTokens: match.absoluteTokens,
            estimatedSuffixTokens,
        };
    };
    const measure = (messages) => {
        const detailed = measureDetailed(messages);
        return { inputTokens: detailed.inputTokens, serializedBytes: detailed.serializedBytes };
    };
    return {
        measure,
        measureDetailed,
        measurePair: ({ beforeMessages, afterMessages }) => ({
            before: measureFresh(beforeMessages),
            after: measureFresh(afterMessages),
        }),
    };
}
function textMessage(text) {
    return { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
}
function strictStringify(value) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined)
            throw new TypeError('value is undefined');
        return serialized;
    }
    catch (cause) {
        throw new TypeError('Context footprint input must be JSON serializable.', { cause });
    }
}
function validateFootprint(inputTokens, serializedBytes) {
    if (!Number.isSafeInteger(inputTokens) ||
        inputTokens < 0 ||
        !Number.isSafeInteger(serializedBytes) ||
        serializedBytes < 0) {
        throw new TypeError('Context footprint must contain non-negative safe integers.');
    }
}
//# sourceMappingURL=local-context-footprint.js.map