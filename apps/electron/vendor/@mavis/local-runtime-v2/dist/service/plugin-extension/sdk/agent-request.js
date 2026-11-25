import { ExtensionServiceError } from '../errors.js';
const DEFAULT_AGENT_TYPE = 'worker';
const DEFAULT_DESCRIPTION_WORDS = 5;
/**
 * The task title rule (`normalizeConversationSessionTitle`), repeated here because this module also
 * runs in the packaged `extension test` Worker, which cannot load that package.
 */
const MAX_DESCRIPTION_CHARS = 50;
function invalid(message) {
    return new ExtensionServiceError('ARGUMENT_INVALID', message);
}
export function parseAgentSpawnSpec(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalid('ctx.agent.spawn takes a spec object');
    }
    const { prompt, description, agentType, model } = raw;
    if (typeof prompt !== 'string' || prompt.trim() === '')
        throw invalid('prompt is required');
    return {
        prompt,
        description: descriptionOf(description, prompt),
        agentType: agentTypeOf(agentType),
        ...modelOf(model),
    };
}
function descriptionOf(value, prompt) {
    if (value === undefined)
        return defaultDescription(prompt);
    const title = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
    if (title === '' || Array.from(title).length > MAX_DESCRIPTION_CHARS) {
        throw invalid(`description must be 1-${MAX_DESCRIPTION_CHARS} characters`);
    }
    return title;
}
function defaultDescription(prompt) {
    const words = prompt.trim().split(/\s+/u).slice(0, DEFAULT_DESCRIPTION_WORDS).join(' ');
    return Array.from(words).slice(0, MAX_DESCRIPTION_CHARS).join('').trim();
}
function agentTypeOf(value) {
    if (value === undefined)
        return DEFAULT_AGENT_TYPE;
    if (typeof value !== 'string' || value.trim() === '') {
        throw invalid('agentType must be a non-empty string');
    }
    return value;
}
function modelOf(value) {
    if (value === undefined)
        return {};
    if (typeof value !== 'string' || !/^[^/\s]+\/\S/u.test(value)) {
        throw invalid('model must be provider/model');
    }
    return { model: value };
}
//# sourceMappingURL=agent-request.js.map