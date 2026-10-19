import { loadModelCacheData } from '../../model-provider/model-cache.js';
import { json, readFirstString, readJsonBody } from '../host-helpers.js';
import { modelSelectionFromSession } from '../host-model-helpers.js';
import { listLocalRuntimeModels } from '../host-support.js';
import { readPersistedLocalModelThinkingSelection } from '../../model-provider/model-selection.js';
export async function routeLocalModelApi(ctx, request, method, parts, url) {
    if (parts[0] !== 'models')
        return undefined;
    if (method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const session = sessionId ? await ctx.getSessionById(sessionId) : undefined;
        const config = ctx.configGetter();
        return json({
            models: listLocalRuntimeModels(config, modelSelectionFromSession(session), {
                cache: loadModelCacheData(config.dataDir),
            }),
        });
    }
    if (method !== 'PUT' || parts[1] !== 'select')
        return undefined;
    const body = await readJsonBody(request);
    const providerId = readFirstString(body, ['providerId', 'provider_id']);
    const modelId = readFirstString(body, ['modelId', 'model_id']);
    const sessionId = readFirstString(body, ['sessionId', 'session_id']);
    const variant = typeof body.variant === 'string' ? body.variant : undefined;
    const hasThinking = Object.prototype.hasOwnProperty.call(body, 'thinking');
    const requestedThinking = hasThinking
        ? readPersistedLocalModelThinkingSelection(body.thinking)
        : undefined;
    if (!providerId || !modelId) {
        return json({ error: 'providerId and modelId are required' }, { status: 400 });
    }
    if (sessionId) {
        const session = await ctx.getSessionById(sessionId);
        if (!session) {
            return json({ success: false, error: 'session not found' }, { status: 404 });
        }
        const fields = {
            effectiveModel: `${providerId}/${modelId}`,
            effectiveModelVariant: variant ?? null,
            ...(requestedThinking !== undefined
                ? { effectiveModelThinking: requestedThinking }
                : session.effectiveModel === `${providerId}/${modelId}`
                    ? {}
                    : { effectiveModelThinking: null }),
        };
        if (!ctx.conversation) {
            return json({ success: false, error: 'Runtime Conversation is unavailable' }, { status: 503 });
        }
        await ctx.conversation.lifecycle.updateSession(sessionId, fields);
        return json({ success: true });
    }
    try {
        await ctx.configUpdater({
            defaultModel: `${providerId}/${modelId}`,
            defaultModelVariant: variant ?? null,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ success: false, error: message }, { status: 400 });
    }
    ctx.onDefaultModelChanged();
    return json({ success: true });
}
//# sourceMappingURL=models.js.map