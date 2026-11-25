import { AppError } from '../errors.js';
import { ACK_EXTENSION_APPLIED, ANSWER_EXTENSION_QUERY, CLOSE_EXTENSION_PANE, INPUT_EXTENSION, LIST_EXTENSION_ENTRIES, PRESS_EXTENSION, RENDER_EXTENSION, REPORT_EXTENSION_FALLBACK, SELECT_EXTENSION, SUBSCRIBE_EXTENSION_STREAM, } from './contracts.gen.js';
import { withRequestParseErrorMapper } from './define-route.js';
const PLUGIN_EXTENSION_ROUTES = new Set([
    LIST_EXTENSION_ENTRIES.name,
    RENDER_EXTENSION.name,
    PRESS_EXTENSION.name,
    INPUT_EXTENSION.name,
    SELECT_EXTENSION.name,
    ACK_EXTENSION_APPLIED.name,
    REPORT_EXTENSION_FALLBACK.name,
    SUBSCRIBE_EXTENSION_STREAM.name,
    ANSWER_EXTENSION_QUERY.name,
    CLOSE_EXTENSION_PANE.name,
]);
/** Malformed extension requests are caller errors, not runtime failures. */
export function withPluginExtensionRequestParseErrorPolicy(bindings) {
    return bindings.map((binding) => PLUGIN_EXTENSION_ROUTES.has(binding.name)
        ? withRequestParseErrorMapper(binding, () => new AppError(400, 'EXTENSION_REQUEST_INVALID', 'Extension request is invalid.'))
        : binding);
}
//# sourceMappingURL=plugin-extension-request-policy.js.map