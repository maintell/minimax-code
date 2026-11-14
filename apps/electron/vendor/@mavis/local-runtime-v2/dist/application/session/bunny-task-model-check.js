import { randomUUID } from 'node:crypto';
import { getRuntimePresetKey, resolveModelAvailability, resolveModelCallRoute, } from '@mavis/config';
import { ModelLoginRequiredError, modelLoginRequiredMessage, } from '../../service/model-system/index.js';
/** Logging/attribution anchor only: resolution writes no Session state. */
const TASK_MODEL_CHECK_ANCHOR = 'bunny_task_model_check';
/**
 * A task model the Runtime cannot resolve; the message says which model and why.
 * @internal Exported only for focused tests.
 */
export class TaskModelCheckError extends Error {
    model;
    reason;
    constructor(model, reason) {
        super(`Model "${model}" cannot be used: ${reason}`);
        this.model = model;
        this.reason = reason;
        this.name = 'TaskModelCheckError';
    }
}
/**
 * The task model needs an OAuth login this Runtime does not have. The model is
 * valid, so saving it is allowed; a dispatch on it is refused with this message.
 */
export class TaskModelLoginRequiredError extends TaskModelCheckError {
    code = 'MODEL_LOGIN_REQUIRED';
    constructor(model, modelId) {
        super(model, modelLoginRequiredMessage(modelId));
        this.name = 'TaskModelLoginRequiredError';
        this.message = this.reason;
    }
}
/**
 * Checks that a task model would resolve on its first turn, without sending a
 * model request:
 * 1. a non-custom route must list the model (the turn gate refuses it otherwise,
 *    and the resolver alone accepts any model id on a configured provider);
 * 2. the real resolver resolves it: BYOK entry present and enabled, api key and
 *    base URL configured, managed base URL known.
 * A custom provider model is left to step 2, exactly as the turn gate leaves a
 * Session-pinned model to the BYOK resolver.
 */
export function createTaskModelCheck(input) {
    return async (selection) => {
        const providerId = selection.providerId?.trim();
        const modelId = selection.modelId?.trim();
        const key = `${providerId || '?'}/${modelId || '?'}`;
        if (!providerId || !modelId)
            throw new TaskModelCheckError(key, 'provider and model id are both required');
        const config = input.config();
        if (resolveModelCallRoute(config, providerId) !== 'custom_provider') {
            const availability = resolveModelAvailability({
                config,
                providerId,
                modelId,
                preset: getRuntimePresetKey(),
                source: 'explicit_request',
            });
            if (!availability.available)
                throw new TaskModelCheckError(key, availability.message);
        }
        try {
            await input.resolver.resolveModel({
                sessionId: TASK_MODEL_CHECK_ANCHOR,
                turnId: `turn_model_check_${randomUUID()}`,
                agentConfig: {
                    system_prompt: '',
                    // Identity is what decides resolvability; thinking parameters never fail it.
                    model: { provider: providerId, model_id: modelId },
                    tools: [],
                    skills: [],
                },
            });
        }
        catch (error) {
            if (error instanceof ModelLoginRequiredError) {
                throw new TaskModelLoginRequiredError(key, modelId);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new TaskModelCheckError(key, message.replace(/^LocalModelResolver:\s*/, ''));
        }
    };
}
//# sourceMappingURL=bunny-task-model-check.js.map