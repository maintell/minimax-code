import { randomUUID } from 'node:crypto';
import { ModelLoginRequiredError, modelLoginRequiredMessage, } from '../../service/model-system/index.js';
/** Logging/attribution anchor only: resolution writes no Session state. */
const DISPATCH_MODEL_LOGIN_CHECK_ANCHOR = 'dispatch_model_login_check';
/**
 * A dispatch refused because its child would run on a model that needs a login first.
 *
 * @internal Exported for tests; callers read its `code` and message.
 */
export class DispatchModelLoginRequiredError extends Error {
    modelId;
    name = 'DispatchModelLoginRequiredError';
    code = 'MODEL_LOGIN_REQUIRED';
    constructor(modelId) {
        super(modelLoginRequiredMessage(modelId));
        this.modelId = modelId;
    }
}
/**
 * Refuses a child that would run on an OAuth model this Runtime has no
 * credentials for, before the child Session exists. It runs the resolution the
 * child's first Turn would run, without sending a model request. Any other
 * resolution failure is left to that Turn, as before.
 */
export function createDispatchModelLoginCheck(resolver) {
    return async ({ providerId, modelId }) => {
        try {
            await resolver.resolveModel({
                sessionId: DISPATCH_MODEL_LOGIN_CHECK_ANCHOR,
                turnId: `turn_model_login_check_${randomUUID()}`,
                agentConfig: {
                    system_prompt: '',
                    model: { provider: providerId, model_id: modelId },
                    tools: [],
                    skills: [],
                },
            });
        }
        catch (error) {
            if (error instanceof ModelLoginRequiredError) {
                throw new DispatchModelLoginRequiredError(modelId);
            }
        }
    };
}
//# sourceMappingURL=dispatch-model-login-check.js.map