/**
 * Wire-shaped channel error (MR3 A).
 *
 * The generated channel methods keep the exact legacy error bodies of the v1
 * DesktopChannelService (jsonError shape / legacy-route passthrough). The
 * application layer cannot construct `Response` objects, so it throws this
 * carrier instead; the HTTP controller serializes `body` verbatim at
 * `status`. Never wrap it into the v2 `{code,key,message}` envelope — the UI
 * parses the legacy `{error, code}` fields.
 */
export class ChannelWireError extends Error {
    status;
    body;
    constructor(status, body) {
        super(typeof body.error === 'string' ? body.error : 'channel wire error');
        this.status = status;
        this.body = body;
        this.name = 'ChannelWireError';
    }
}
/** jsonError-shaped body (v1 `desktop-service-support.jsonError` twin). */
export function channelWireError(status, message, code) {
    return new ChannelWireError(status, {
        error: message,
        ...(code ? { code } : {}),
    });
}
export function isChannelWireError(err) {
    return (err instanceof Error &&
        err.name === 'ChannelWireError' &&
        typeof err.status === 'number' &&
        typeof err.body === 'object');
}
export function isAgentContractLikeError(err) {
    return (err instanceof Error &&
        err.name === 'LocalAgentContractError' &&
        typeof err.status === 'number' &&
        typeof err.code === 'string');
}
//# sourceMappingURL=wire-error.js.map