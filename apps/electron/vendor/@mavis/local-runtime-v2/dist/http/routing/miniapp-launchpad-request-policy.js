import { AppError } from '../errors.js';
import { withRequestParseErrorMapper } from './define-route.js';
/** Malformed Mini App requests are client errors, including missing account identity. */
export function withMiniAppLaunchpadRequestParseErrorPolicy(bindings) {
    return bindings.map((binding) => binding.meta.path.startsWith('/minimax-desktop/api/v1/miniapps/launchpad/')
        ? withRequestParseErrorMapper(binding, () => new AppError(400, 'invalid_request', 'Invalid Mini App request'))
        : binding);
}
//# sourceMappingURL=miniapp-launchpad-request-policy.js.map