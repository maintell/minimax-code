import { getRuntimeRegion } from '@mavis/config';
import { readPromptBundleScopeWithBuiltinFallback } from '../runtime/prompt-read.js';
import { loadBuiltinReviewPromptTemplates, REVIEW_PROMPT_KEYS, ReviewPreparationService, } from './preparation.js';
import { ReviewPreferencesService } from './preferences.js';
export async function prepareReview(input, options) {
    const builtin = await loadBuiltinReviewPromptTemplates(options.reviewPromptDir);
    const resolved = await readPromptTemplates(builtin, input.promptRead, options.promptSnapshots?.());
    const prepared = await new ReviewPreparationService({
        preferences: new ReviewPreferencesService(options.configGetter().dataDir),
        configGetter: options.configGetter,
        regionGetter: getRuntimeRegion,
    }).prepare(input, resolved.templates);
    return {
        prepared,
        ...(resolved.promptRead ? { promptRead: resolved.promptRead } : {}),
    };
}
async function readPromptTemplates(builtin, promptRead, promptSnapshots) {
    const resolved = await readPromptBundleScopeWithBuiltinFallback(promptRead ?? promptSnapshots, [
        { key: REVIEW_PROMPT_KEYS.reviewer, builtin: builtin.reviewer },
        { key: REVIEW_PROMPT_KEYS.candidates, builtin: builtin.candidates },
    ]);
    return {
        templates: {
            reviewer: resolved.templates.get(REVIEW_PROMPT_KEYS.reviewer) ?? builtin.reviewer,
            candidates: resolved.templates.get(REVIEW_PROMPT_KEYS.candidates) ?? builtin.candidates,
        },
        ...(resolved.promptRead ? { promptRead: resolved.promptRead } : {}),
    };
}
//# sourceMappingURL=prompt-preparation.js.map