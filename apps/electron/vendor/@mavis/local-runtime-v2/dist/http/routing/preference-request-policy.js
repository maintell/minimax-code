import { AppError } from '../errors.js';
import { PUT_COMPUTER_USE_DEFAULT_PREFERENCE } from './contracts.gen.js';
import { withRequestParseErrorMapper } from './define-route.js';
export function withPreferenceRequestParseErrorPolicy(bindings) {
    return bindings.map((binding) => binding.name === PUT_COMPUTER_USE_DEFAULT_PREFERENCE.name
        ? withRequestParseErrorMapper(binding, () => new AppError(400, 'INVALID_COMPUTER_USE_PREFERENCE', 'enabled must be a boolean'))
        : binding);
}
//# sourceMappingURL=preference-request-policy.js.map