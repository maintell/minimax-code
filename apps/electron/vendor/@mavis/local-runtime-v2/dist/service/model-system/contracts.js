/**
 * The model's provider signs in with OAuth and this Runtime holds no
 * credentials for it. Model resolution throws it; a dispatch that would create
 * a child Session on such a model refuses before the Session exists.
 */
export class ModelLoginRequiredError extends Error {
    authProvider;
    name = 'ModelLoginRequiredError';
    code = 'MODEL_LOGIN_REQUIRED';
    constructor(authProvider) {
        super(`LocalModelResolver: ${authProvider} login required; no OAuth credentials found.`);
        this.authProvider = authProvider;
    }
}
/** The error a refused dispatch returns to the calling model. No other model is picked. */
export function modelLoginRequiredMessage(modelName) {
    return `${modelName} 需要登录，请换一个模型或请用户登录`;
}
export class LocalModelProviderError extends Error {
    status;
    code;
    name = 'LocalModelProviderError';
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
//# sourceMappingURL=contracts.js.map