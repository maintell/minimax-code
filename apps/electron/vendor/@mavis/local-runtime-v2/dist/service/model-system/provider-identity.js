/** OAuth and model-access providers (and retired `borrowed` entries) are not API-key identities, even with stray key fields. */
export function isApiKeyProvider(provider) {
    return (!!provider &&
        provider.kind !== 'borrowed' &&
        provider.kind !== 'model-access' &&
        provider.kind !== 'oauth' &&
        provider.options?.authMode !== 'oauth' &&
        provider.api !== 'openai-codex-responses');
}
export function normalizeProviderIdentityBaseUrl(baseUrl) {
    return baseUrl.trim().replace(/\/+$/, '');
}
//# sourceMappingURL=provider-identity.js.map