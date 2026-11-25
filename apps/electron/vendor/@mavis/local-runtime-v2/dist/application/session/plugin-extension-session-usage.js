import { formatModelKey, lookupLocalModelLimits, parseSourceQualifiedModelKey, } from '../../service/model-system/index.js';
const PAGE_SIZE = 50;
/** Newest messages searched for a snapshot; a reply is measured, so it is near the end. */
const MAX_SCANNED_MESSAGES = 2_000;
/**
 * Session facts behind `ctx.session.usage()`: read-only, nothing is recomputed. The snapshot is
 * the latest `context_usage` a committed message carries (assistant replies and compactions), the
 * same record the context meter shows; the window without one comes from the Turn's resolver.
 */
export function createPluginExtensionSessionUsage(deps) {
    const scans = new Map();
    const row = async (sessionId) => {
        const found = await deps.sessions.get(sessionId);
        if (!found)
            throw new Error(`session ${sessionId} is missing`);
        return found;
    };
    return {
        startedAt: async (sessionId) => (await row(sessionId)).createdAtMs,
        latestContext: async (sessionId) => {
            const previous = scans.get(sessionId);
            const result = await latestContext(deps.messages, sessionId, previous);
            scans.delete(sessionId);
            if (result.snapshot === undefined && result.newestId !== undefined) {
                scans.set(sessionId, result.newestId);
                const oldest = scans.keys().next().value;
                if (scans.size > 512 && oldest !== undefined)
                    scans.delete(oldest);
            }
            return result.snapshot;
        },
        contextWindow: async (sessionId) => contextWindow(deps, sessionId, await row(sessionId)),
    };
}
async function latestContext(messages, sessionId, previous) {
    let before;
    let newestId;
    for (let scanned = 0; scanned < MAX_SCANNED_MESSAGES; scanned += PAGE_SIZE) {
        const page = await messages.list(sessionId, {
            limit: PAGE_SIZE,
            ...(before === undefined ? {} : { before }),
        });
        if (scanned === 0)
            newestId = messageId(page.messages.at(-1));
        newestId = cacheableWatermark(page, newestId);
        // A page is chronological; the newest message is last.
        for (let index = page.messages.length - 1; index >= 0; index -= 1) {
            const snapshot = snapshotOf(page.messages[index]);
            if (snapshot)
                return { newestId, snapshot };
            if (previous && page.messages[index]?.['msg_id'] === previous) {
                return { newestId };
            }
        }
        if (!page.hasMore || page.nextCursor === undefined)
            return { newestId };
        before = page.nextCursor;
    }
    return { newestId };
}
function cacheableWatermark(page, newestId) {
    return page.messages.some((message) => message['kind'] === 'compaction_start')
        ? undefined
        : newestId;
}
function messageId(message) {
    const id = message?.['msg_id'];
    return typeof id === 'string' ? id : undefined;
}
function snapshotOf(message) {
    const value = message?.context_usage ?? message?.contextUsage;
    if (!isRecord(value))
        return undefined;
    const { contextWindowTokens, usedTokens } = value;
    if (!isCount(contextWindowTokens) || contextWindowTokens <= 0 || !isCount(usedTokens))
        return undefined;
    const components = Array.isArray(value.components)
        ? value.components.flatMap((component) => isRecord(component) && typeof component.kind === 'string' && isCount(component.tokens)
            ? [{ kind: component.kind, tokens: component.tokens }]
            : [])
        : [];
    return { contextWindowTokens, usedTokens, components };
}
/**
 * The limit the Turn would apply, if any: a stored limit counts only for the model it was chosen
 * for, and the config default's limit comes with the config default itself. A Task whose model is
 * frozen, or a selection that was replaced, has its own model: the default's limit is not it.
 */
function chosenLimit(deps, session, key, configDefault) {
    const chosen = session.effectiveModelContextWindow;
    if (session.effectiveModel === key && typeof chosen === 'number' && chosen > 0)
        return chosen;
    if (configDefault() !== key)
        return undefined;
    const limit = deps.modelConfig.read().defaultModelContextWindow;
    return typeof limit === 'number' && limit > 0 ? limit : undefined;
}
/** The config default as `sessionModel` spells it, so the two keys compare directly. */
function configDefaultKey(deps) {
    const raw = deps.modelConfig.read().defaultModel;
    const model = raw ? parseSourceQualifiedModelKey(raw) : undefined;
    if (!model?.providerId || !model.modelId)
        return undefined;
    return formatModelKey(model.providerId, model.modelId);
}
/**
 * The Turn's rule: the session's chosen context limit when it still runs the model it was chosen
 * for, else the model's own window. Unresolvable credentials do not hide the window: the same
 * catalog limits the resolver falls back to answer it.
 */
async function contextWindow(deps, sessionId, session) {
    const key = await deps.sessionModel(sessionId);
    const model = parseSourceQualifiedModelKey(key);
    if (!key || !model)
        throw new Error(`session ${sessionId} has no model`);
    const limit = chosenLimit(deps, session, key, () => configDefaultKey(deps));
    try {
        const resolved = await deps.resolver.resolveModel({
            sessionId,
            turnId: `ext:usage:${sessionId}`,
            agentConfig: {
                system_prompt: '',
                model: {
                    provider: model.providerId,
                    model_id: model.modelId,
                    ...(limit === undefined ? {} : { context_window: limit }),
                },
                tools: [],
                skills: [],
            },
        });
        if (resolved.model.contextWindow > 0)
            return resolved.model.contextWindow;
    }
    catch {
        // Fall through to the catalog limits the resolver itself would use.
    }
    return limit ?? lookupLocalModelLimits(model.providerId, model.modelId).contextWindow;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
//# sourceMappingURL=plugin-extension-session-usage.js.map