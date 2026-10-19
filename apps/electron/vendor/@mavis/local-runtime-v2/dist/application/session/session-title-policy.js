import { resolveProviderAuthMode } from '@mavis/config';
import { SAFETY_SCENE } from '../../service/content-safety/index.js';
import { isLegacyMinimaxProvider, parseSourceQualifiedModelKey, } from '../../service/model-system/index.js';
/** Local CLI metadata follows the selected provider, without requiring inference credentials. */
export function createSessionTitlePolicy(input) {
    return {
        blocks: async (title, session) => {
            if (!title.trim())
                return false;
            if (input.runtimeOwnerKind === 'tui' || input.runtimeOwnerKind === 'cli') {
                const config = input.config();
                const model = await selectedModel(session, config, input.readDefinition);
                if (model && isUnmanagedProvider(config, model))
                    return false;
            }
            // Missing/ambiguous provider context retains the existing gate, as do all
            // managed routes. In particular, auth and local errors still block.
            return input.safety.blocks(title, SAFETY_SCENE.ConfigField);
        },
    };
}
async function selectedModel(session, config, readDefinition) {
    if (session.sessionKind === 'task') {
        const binding = await readDefinition(session.sessionId);
        if (binding?.definition.definitionVersion !== 2)
            return undefined;
        const { providerId, modelId } = binding.definition.model;
        return parseSourceQualifiedModelKey(`${providerId}/${modelId}`);
    }
    return parseSourceQualifiedModelKey(session.effectiveModel ?? config.defaultModel);
}
function isUnmanagedProvider(config, model) {
    if (isLegacyMinimaxProvider(config, model.providerId))
        return false;
    if (model.source === 'minimax_api')
        return true;
    if (model.source === 'custom_provider') {
        const provider = config.custom_provider?.[model.providerKey];
        return provider !== undefined && provider.enabled !== false;
    }
    if (model.providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key')
        return true;
    const provider = config.provider?.[model.providerId];
    return (provider !== undefined && resolveProviderAuthMode(provider.options).authMode !== 'managed-login');
}
//# sourceMappingURL=session-title-policy.js.map