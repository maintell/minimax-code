import { AppError } from '../errors.js';
import { withRequestParseErrorMapper } from './define-route.js';
// Secrets, live login flows, account usage and local candidates must never be cached.
const NO_STORE_METHODS = new Set([
    'revealModelProviderApiKey',
    'beginModelAccessLogin',
    'getModelAccessLoginStatus',
    'submitModelAccessLogin',
    'cancelModelAccessLogin',
    'discoverModelAccessBorrow',
    'scanModelAccessApi',
    'listModelAccessApiCandidates',
    'queryModelAccessUsage',
    'testUserModelApiKey',
]);
// Failover views expose account state (no-store); missing or mistyped bindings are client errors, not 500s.
const FAILOVER_METHODS = new Set([
    'getModelAccessFailover',
    'setModelAccessFailover',
]);
export function withModelProviderResponsePolicy(bindings) {
    return bindings.map((binding) => {
        if (binding.kind !== 'json')
            return binding;
        if (FAILOVER_METHODS.has(binding.name)) {
            return withRequestParseErrorMapper({
                ...binding,
                responseHeaders: { ...binding.responseHeaders, 'Cache-Control': 'no-store' },
            }, () => new AppError(400, 'VALIDATION_ERROR', 'Invalid failover request'));
        }
        return NO_STORE_METHODS.has(binding.name)
            ? { ...binding, responseHeaders: { ...binding.responseHeaders, 'Cache-Control': 'no-store' } }
            : binding;
    });
}
//# sourceMappingURL=model-provider-response-policy.js.map