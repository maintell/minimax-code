/**
 * Stable "no live client for this context" contract. Raised by the channel
 * owner's delivery edges and by the no-IM port; mapped by consumers (HTTP
 * wrapper, cron delivery) to the legacy 503 body. Lives in the port contract
 * file so it survives without any channel implementation in this package.
 */
export const CHANNEL_CLIENT_UNAVAILABLE = 'CHANNEL_CLIENT_UNAVAILABLE';
export class LocalChannelClientUnavailableError extends Error {
    status = 503;
    code = CHANNEL_CLIENT_UNAVAILABLE;
    constructor(ctx) {
        super(`${CHANNEL_CLIENT_UNAVAILABLE}: ${ctx.platform}:${ctx.clientName}`);
        this.name = 'LocalChannelClientUnavailableError';
    }
}
//# sourceMappingURL=host-channel-port.js.map