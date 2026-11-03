import { logger } from '../../../../infra/logging/logger.js';
import { buildResponsesInputTokensRequestBody, responsesInputTokensBodyHasImages, responsesInputTokensBodyHasVideo, } from '../token-counting/responses-input-tokens-body.js';
import {} from './types.js';
import { isManagedLoginTokenPlan } from './managed-login.js';
import { parseTopLevelInputTokens } from './parse.js';
export const minimaxResponsesTokenCounterAdapter = {
    id: 'minimax-responses',
    counterKind: 'responses',
    matches: (ctx) => ctx.model.provider === 'minimax_api',
    buildRequest: (ctx) => buildResponsesCounterRequest(ctx, true),
    parseTokens: parseTopLevelInputTokens,
};
export const genericResponsesTokenCounterAdapter = {
    id: 'generic-responses',
    counterKind: 'responses',
    matches: (ctx) => {
        if (ctx.model.api !== 'openai-completions' && ctx.model.api !== 'openai-responses') {
            return false;
        }
        return !isManagedLoginTokenPlan(ctx);
    },
    buildRequest: (ctx) => buildResponsesCounterRequest(ctx, false),
    parseTokens: parseTopLevelInputTokens,
};
function buildResponsesCounterRequest(ctx, isMinimaxApi) {
    const body = buildResponsesInputTokensRequestBody(ctx.messages, ctx.systemPrompt, ctx.model, ctx.tools);
    if (isMinimaxApi && responsesInputTokensBodyHasVideo(body)) {
        logger.info({ model: ctx.model.id, provider: ctx.model.provider }, '[local-remote-token-counter] MiniMax Responses input_tokens does not accept video; using BPE fallback');
        return undefined;
    }
    const apiKey = ctx.apiKey ?? '';
    const baseUrl = ctx.model.baseUrl;
    return {
        url: buildResponsesInputTokensUrl(baseUrl, {
            stripMessagesCompatibilityPrefix: isMinimaxApi,
        }),
        unsupportedCacheKey: `responses:${baseUrl}`,
        body,
        headers: {
            authorization: `Bearer ${apiKey}`,
            ...(ctx.headers ?? {}),
            'Content-Type': 'application/json',
        },
        hasImages: responsesInputTokensBodyHasImages(body),
    };
}
/** @internal Exported only for focused tests. */
export function buildResponsesInputTokensUrl(baseUrl, options = {}) {
    const trimmed = baseUrl.trim().replace(/\/+$/u, '');
    if (!trimmed)
        return '/v1/responses/input_tokens';
    try {
        const url = new URL(trimmed);
        url.pathname = buildResponsesInputTokensPath(url.pathname, options);
        url.search = '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return buildResponsesInputTokensFallback(trimmed, options);
    }
}
function stripEndpointSuffix(root) {
    if (root.endsWith('/chat/completions'))
        return root.slice(0, -'/chat/completions'.length);
    if (root.endsWith('/responses'))
        return root.slice(0, -'/responses'.length);
    return root;
}
function buildResponsesInputTokensPath(pathname, options) {
    const currentPath = pathname.replace(/\/+$/u, '');
    if (currentPath.endsWith('/responses/input_tokens'))
        return currentPath;
    let root = stripEndpointSuffix(currentPath);
    if (options.stripMessagesCompatibilityPrefix)
        root = stripMessagesCompatibilityPrefix(root);
    if (!endsWithVersionSegment(root))
        root = `${root}/v1`;
    return `${root}/responses/input_tokens`.replace(/\/{2,}/gu, '/');
}
function buildResponsesInputTokensFallback(baseUrl, options) {
    if (baseUrl.endsWith('/responses/input_tokens'))
        return baseUrl;
    let root = stripEndpointSuffix(baseUrl);
    if (options.stripMessagesCompatibilityPrefix)
        root = stripMessagesCompatibilityPrefix(root);
    if (!endsWithVersionSegment(root))
        root = `${root}/v1`;
    return `${root}/responses/input_tokens`;
}
/**
 * Base URLs of OpenAI-compatible gateways are often already versioned
 * (`/v1`, but also `/api/paas/v4`, `/api/coding/paas/v4`, ...). Appending
 * `/v1` after an existing version segment can only produce a path that no
 * gateway serves, so treat any trailing `/v<digits>` as the API root.
 */
function endsWithVersionSegment(root) {
    return /\/v\d+$/u.test(root);
}
const MESSAGES_API = 'anthropic-messages';
const MESSAGES_COMPATIBILITY_SUFFIX = `/${MESSAGES_API.slice(0, -'-messages'.length)}`;
const MESSAGES_COMPATIBILITY_SUFFIX_RE = new RegExp(`${MESSAGES_COMPATIBILITY_SUFFIX}(?=/v1$|$)`, 'u');
function stripMessagesCompatibilityPrefix(root) {
    return root.replace(MESSAGES_COMPATIBILITY_SUFFIX_RE, '');
}
//# sourceMappingURL=responses.js.map