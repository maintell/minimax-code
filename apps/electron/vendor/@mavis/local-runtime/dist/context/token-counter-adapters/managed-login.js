import { MANAGED_PROVIDER_API_KEY_PLACEHOLDER } from '../../runtime/model-resolver.js';
export function isManagedLoginTokenPlan(ctx) {
    if (ctx.apiKey !== MANAGED_PROVIDER_API_KEY_PLACEHOLDER)
        return false;
    return Object.keys(ctx.headers ?? {}).some((key) => key.toLowerCase() === 'token');
}
//# sourceMappingURL=managed-login.js.map