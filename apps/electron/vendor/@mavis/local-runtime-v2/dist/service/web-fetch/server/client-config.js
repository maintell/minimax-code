export class WebFetchClientConfigCache {
    serverSwitch;
    now;
    /** Users the server answered `not_enabled` for, until their retry window ends. */
    disabledUntilMs = new Map();
    constructor(options) {
        this.serverSwitch = options.serverSwitch;
        this.now = options.now ?? Date.now;
    }
    /** The switch for this user, before mcp-server's own per-user answer. */
    serverReaderSwitchedOn(userKey) {
        return this.serverSwitch.serverReaderEnabled(userKey);
    }
    get(userKey) {
        if (!this.serverReaderSwitchedOn(userKey))
            return DISABLED_CONFIG;
        const disabledUntil = this.disabledUntilMs.get(userKey);
        if (disabledUntil !== undefined && disabledUntil > this.now())
            return DISABLED_CONFIG;
        if (disabledUntil !== undefined)
            this.disabledUntilMs.delete(userKey);
        return ENABLED_CONFIG;
    }
    /**
     * The server declined this user. Honour its retry window instead of asking
     * again on the next fetch.
     */
    disableUntil(userKey, retryAfterMs) {
        const windowMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_MS;
        this.disabledUntilMs.set(userKey, this.now() + windowMs);
    }
}
const DISABLED_CONFIG = { serverReaderEnabled: false };
const ENABLED_CONFIG = { serverReaderEnabled: true };
const DEFAULT_RETRY_MS = 10 * 60_000;
//# sourceMappingURL=client-config.js.map