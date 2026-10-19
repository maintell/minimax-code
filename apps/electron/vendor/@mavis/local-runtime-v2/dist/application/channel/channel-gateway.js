/**
 * Structured gateway between the Channel Application and the legacy channel
 * HTTP surface (MR3 A).
 *
 * The application layer performs the SAME request sequences the verified v1
 * `DesktopChannelServiceBase.localApiJson` performed, but expressed as
 * structured invocations: the HTTP controller implements this port over the
 * channel system's `legacyHttp.dispatch` (in-process, no socket), keeping
 * Request/Response construction out of the application layer while the wire
 * behavior stays byte-for-byte with v1.
 */
import { ChannelWireError } from './wire-error.js';
/**
 * v1 `localApiJson` twin: non-2xx throws the legacy body verbatim; 204/empty
 * bodies decode to `{}`.
 */
export async function gatewayJson(gateway, path, init) {
    const result = await gateway.request(path, init);
    if (!result.ok)
        throw wireErrorFromGatewayResult(result);
    if (result.status === 204 || !result.bodyText)
        return {};
    return JSON.parse(result.bodyText);
}
/** Carries the legacy error payload through untouched (v1 res passthrough). */
export function wireErrorFromGatewayResult(result) {
    return new ChannelWireError(result.status, parseGatewayBody(result.bodyText));
}
/** v1 `readLocalApiErrorCode` twin over an already-buffered body. */
export function gatewayErrorCode(result) {
    const code = parseGatewayBody(result.bodyText).code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
}
function parseGatewayBody(bodyText) {
    try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Non-JSON legacy bodies degrade to the plain-error shape below.
    }
    return { error: bodyText || 'channel request failed' };
}
//# sourceMappingURL=channel-gateway.js.map