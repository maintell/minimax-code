import { withEffectivePromptSuggestion } from '@mavis/config';
/**
 * Fills the effective prompt-suggestion opt-in into a host's config read
 * boundary: its getter and its updater's answer. The runtime switch and the
 * GET/PUT `/config` answers all read these two, so every reader sees one value.
 */
export function withEffectivePromptSuggestionConfig(boundary) {
    const effective = (config) => withEffectivePromptSuggestion(config, boundary.getPromptSuggestionPolicy?.());
    return {
        configGetter: () => effective(boundary.configGetter()),
        configUpdater: async (body) => {
            const result = await boundary.configUpdater(body);
            return { ...result, config: effective(result.config) };
        },
    };
}
//# sourceMappingURL=effective-prompt-suggestion.js.map