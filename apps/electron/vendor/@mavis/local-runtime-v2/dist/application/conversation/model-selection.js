import { normalizeModelSelection, } from '../../service/turn-system/index.js';
import { ApplicationError } from './errors.js';
// Every wire field must explicitly be a user choice or a server-owned budget.
const selectionFields = {
    providerId: true,
    modelId: true,
    variant: true,
    reasoning: true,
    thinking: true,
    contextLimit: true,
    contextWindow: false,
    maxOutputTokens: false,
};
export function toUserModelSelection(input) {
    const choices = Object.fromEntries(Object.entries(selectionFields)
        .filter(([, selected]) => selected)
        .map(([key]) => [key, input[key] ?? undefined]));
    try {
        return normalizeModelSelection(choices);
    }
    catch (error) {
        throw new ApplicationError(400, 'invalid-model', error instanceof Error ? error.message : 'Invalid model selection');
    }
}
//# sourceMappingURL=model-selection.js.map