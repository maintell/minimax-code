import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import { createAutomaticFootprintMeasurer } from '../../compaction/automatic-context-compactor.js';
export function fitsReminderInFinalRequest(input, marker, usageAnchor) {
    const footprint = createAutomaticFootprintMeasurer(input, usageAnchor).measure([
        ...input.messages,
        marker,
    ]);
    const { providerInputLimit } = resolveCompactionTokenBudget({
        contextWindow: input.model.contextWindow,
        configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
    });
    return (footprint.inputTokens <= providerInputLimit &&
        (input.maxSerializedInputBytes === undefined ||
            footprint.serializedBytes <= input.maxSerializedInputBytes));
}
//# sourceMappingURL=reminder-admission.js.map