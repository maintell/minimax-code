import { LegacyOpencodeMigrator } from '../../../infra/legacy-db/legacy-opencode-migrator.js';
import { resolveLocalAppMode } from '../../../infra/runtime-owner/app-mode.js';
import { json, readString } from '../../../infra/transport/host-http.js';
import { readPersistedLocalModelThinkingSelection } from '../../../infra/conversation/model-selection.js';
import { resolveWritableModelSelection } from './model-selection-write.js';
export const DEFAULT_LOCAL_AGENT_AVATAR_URL = 'https://filecdn.minimax.chat/public/d92edcbe-2404-417b-a133-b770b0b9bf61.svg';
export function buildLegacyAgentIdentity(agent, name) {
    const displayName = agent?.displayName ?? name;
    return {
        displayName,
        identity: {
            display_name: displayName,
            avatar: agent?.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
        },
        description: agent?.description ?? 'Legacy opencode sessions pending local Pi migration',
        ...(agent?.persona ? { persona: agent.persona } : {}),
        ...(agent?.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    };
}
export function readSessionAppMode(body, parent) {
    const requested = readString(body, 'appMode') ?? readString(body, 'app_mode');
    return resolveLocalAppMode(requested ?? parent?.appMode);
}
/**
 * Reads the model a new Session is created with. The key is canonicalized
 * and route-checked before it is stored, because a Session only ever sees
 * this string again: a BYOK provider written without its `custom_provider:`
 * prefix would resolve as a built-in managed provider on the first Turn.
 */
export function readSessionModelSelection(config, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: true, fields: {} };
    }
    const model = Object.fromEntries(Object.entries(value));
    const providerId = readString(model, 'provider_id');
    const modelId = readString(model, 'model_id');
    if (!providerId || !modelId)
        return { ok: true, fields: {} };
    const resolved = resolveWritableModelSelection(config, providerId, modelId);
    if (!resolved.ok)
        return resolved;
    return {
        ok: true,
        fields: {
            effectiveModel: resolved.selection.modelKey,
            effectiveModelVariant: readString(model, 'variant') ?? null,
            ...(Object.prototype.hasOwnProperty.call(model, 'thinking')
                ? { effectiveModelThinking: readPersistedLocalModelThinkingSelection(model.thinking) }
                : {}),
        },
    };
}
export function readOnlyLegacySessionResponse() {
    return json({
        success: false,
        error: 'Legacy opencode sessions are read-only in clean local-runtime mode.',
        code: 'read_only_legacy_session',
    }, { status: 409 });
}
export function isPiRootSession(session, agentName) {
    return (session.agentName === agentName &&
        session.runtime === 'pi-agent' &&
        session.sessionType === 'root');
}
export function isActivePiRootSession(session, agentName) {
    return isPiRootSession(session, agentName) && !session.archived;
}
export function resolvePreferredLegacyRootSession(sessions, preferredRootSessionId) {
    if (preferredRootSessionId) {
        const preferred = sessions.find((session) => session.sessionType === 'root' &&
            (session.sessionId === preferredRootSessionId ||
                session.legacyFrameworkSessionId === preferredRootSessionId));
        if (preferred)
            return preferred;
    }
    return sessions.find((session) => session.sessionType === 'root') ?? sessions[0];
}
//# sourceMappingURL=agent-route-support.js.map