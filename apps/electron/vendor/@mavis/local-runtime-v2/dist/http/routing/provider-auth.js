import { CodexOAuthError } from '../../service/model-system/index.js';
const CODEX_OAUTH_PATH = '/mavis/api/provider-auth/openai-codex';
/** Preserve the product HTTP contract while moving OAuth ownership into Runtime V2. */
export function mountProviderAuthRoutes(app, manager) {
    app.get(CODEX_OAUTH_PATH, async (context) => {
        return context.json(manager.getStatus());
    });
    for (const [path, action] of [
        [CODEX_OAUTH_PATH, () => manager.startLogin()],
        [`${CODEX_OAUTH_PATH}/models`, () => manager.refreshModels()],
    ]) {
        app.post(path, async (context) => {
            try {
                return context.json(await action());
            }
            catch (error) {
                if (error instanceof CodexOAuthError) {
                    return context.json({ error: error.message, code: error.code }, error.status);
                }
                return context.json({ error: 'Codex OAuth request failed.', code: 'OAUTH_REQUEST_FAILED' }, 500);
            }
        });
        app.all(path, (context) => context.json({ error: 'Method not allowed.' }, 405));
    }
}
//# sourceMappingURL=provider-auth.js.map