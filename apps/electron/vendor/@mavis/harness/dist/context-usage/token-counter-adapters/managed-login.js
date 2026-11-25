/**
 * Placeholder credential a managed-login provider plan carries instead of a real
 * api key; the real token travels in the `token` header.
 */
export const MANAGED_PROVIDER_API_KEY_PLACEHOLDER = 'sk-xxx';
export function isManagedLoginTokenPlan(ctx) {
    if (ctx.apiKey !== MANAGED_PROVIDER_API_KEY_PLACEHOLDER)
        return false;
    return Object.keys(ctx.headers ?? {}).some((key) => key.toLowerCase() === 'token');
}
//# sourceMappingURL=managed-login.js.map