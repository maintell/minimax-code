import { CUSTOM_PROVIDER_ID_PREFIX, MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID, } from '@mavis/config';
export { CUSTOM_PROVIDER_ID_PREFIX, MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID };
export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';
/**
 * `custom_provider.<key>.kind` for a model-access extension binding. Its config
 * stores only extension metadata (`options.modelAccess`) and the committed catalog;
 * credentials stay in the extension binding and are opened per call.
 */
export const MODEL_ACCESS_PROVIDER_KIND = 'model-access';
export const MODEL_PROVIDER_SOURCES = ['provider', 'minimax_api', 'custom_provider'];
/**
 * The generic BYOK wire protocols: a user-supplied base URL plus a bearer,
 * `x-api-key` or `x-goog-api-key` credential that this runtime drives itself.
 * Membership decides base-URL normalization, connection-test and discovery URL
 * shapes, and whether a Thinking request patch is synthesized for the provider.
 *
 * `openai-codex-responses` is deliberately excluded even though
 * `LocalCustomProviderConfig.api` accepts it. The Codex OAuth provider is not a
 * generic endpoint: its credentials, base URL and reasoning controls are owned
 * by Pi's dedicated Codex transport, so this runtime must not rewrite its base
 * URL or inject a BYOK Thinking patch. Its Thinking level is still resolved and
 * exposed through the ordinary non-`anthropic-messages` path.
 */
export const MODEL_PROVIDER_APIS = [
    'anthropic-messages',
    'openai-completions',
    'openai-responses',
    'google-generative-ai',
];
const MODEL_PROVIDER_API_SET = new Set(MODEL_PROVIDER_APIS);
export function isModelProviderApi(value) {
    return MODEL_PROVIDER_API_SET.has(value);
}
/** Extension-owned fetch transports do not use generic BYOK URL/auth/thinking rewrites. */
export function isModelAccessApi(value) {
    return isModelProviderApi(value) || value === 'openai-codex-responses';
}
//# sourceMappingURL=identity.js.map