import { assertAgentHostCapabilityAvailable } from '../empty-dependencies.js';
import { AgentEventAssociationError } from '../local-agent-host.js';
export function validateRoutedTurnTools(tools) {
    return tools.reduce((catalog, tool) => {
        if (catalog.some((candidate) => candidate.def.name === tool.def.name)) {
            throw new Error(`Duplicate tool name '${tool.def.name}' after v2 tool routing.`);
        }
        return [...catalog, tool];
    }, []);
}
export function validateOptions(options) {
    assertAgentHostCapabilityAvailable('local-runtime-turn-runner', typeof options.runtime?.runTurn === 'function');
    assertAgentHostCapabilityAvailable('turn-execution-preparation', typeof options.executionPreparation?.prepare === 'function');
    assertAgentHostCapabilityAvailable('turn-file-change-lifecycle', [
        options.fileChanges?.begin,
        options.fileChanges?.finalize,
        options.fileChanges?.markFailed,
    ].every((operation) => typeof operation === 'function'));
    if (Boolean(options.preparePluginHookSessionOwnership) !==
        Boolean(options.activatePluginHookSessionOwnership)) {
        throw new TypeError('Plugin Hook Session ownership preparation and activation must be paired.');
    }
}
export function validateResolvedInput(resolved) {
    validateResolvedPrompt(resolved);
    validateResolvedTools(resolved);
    validateResolvedBeforeLlmCallHooks(resolved);
}
function validateResolvedBeforeLlmCallHooks(resolved) {
    if (!Array.isArray(resolved.beforeLlmCallHooks) ||
        resolved.beforeLlmCallHooks.some((hook) => typeof hook !== 'function')) {
        throw new TypeError('Resolved host beforeLlmCall hooks are invalid.');
    }
}
function validateResolvedPrompt(resolved) {
    if (!resolved.llm?.model)
        throw new TypeError('Resolved LLMModelConfig.model is required.');
    if (typeof resolved.systemPrompt !== 'string') {
        throw new TypeError('Resolved system prompt is invalid.');
    }
    if (typeof resolved.userMessage?.text !== 'string') {
        throw new TypeError('Prepared user message is invalid.');
    }
    if (resolved.userMessage.attachments !== undefined &&
        !Array.isArray(resolved.userMessage.attachments)) {
        throw new TypeError('Prepared user message attachments are invalid.');
    }
}
function validateResolvedTools(resolved) {
    if (!resolved.tools?.context || typeof resolved.tools.permissionGuard !== 'function') {
        throw new TypeError('Resolved host tool and permission context is invalid.');
    }
    if (resolved.toolContext.sessionId !== resolved.input.lease.sessionId) {
        throw new AgentEventAssociationError('sessionId', resolved.input.lease.sessionId, resolved.toolContext.sessionId);
    }
    if (resolved.toolContext.turnId !== resolved.input.lease.turnId) {
        throw new AgentEventAssociationError('turnId', resolved.input.lease.turnId, resolved.toolContext.turnId);
    }
}
//# sourceMappingURL=executor-validation.js.map